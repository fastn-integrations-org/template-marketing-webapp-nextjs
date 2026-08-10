export default async function (ctx) {
  const TEMPLATE_ID = "cfg_0a958721d430"; // getByTemplate resolves the installation's clone
  const CURSOR_KEY = "c7hs:cursor:deal:hubspot-to-cin7";
  const IDMAP = (id) => `c7hs:idmap:deal:h2c:${id}`;
  const HASH = (id) => `c7hs:hash:deal:h2c:${id}`;
  const COMPANY_IDMAP = (id) => `c7hs:idmap:company:h2c:${id}`;
  const SALE_IDMAP = (saleId) => `c7hs:idmap:sale:c2h:${saleId}`;
  const SALE_LINES_DONE = (saleId) => `c7hs:lines:sale:c2h:${saleId}`;
  const PRODUCT_IDMAP = (id) => `c7hs:idmap:product:h2c:${id}`;

  const NONEDITABLE = new Set(["AUTHORISED","AUTHORIZED","INVOICED","FULFILLED","COMPLETED","PARTIALLY INVOICED","PARTIALLY FULFILLED","PAID","PARTIALLY PAID","VOIDED"]);
  const isEditable = (s) => !NONEDITABLE.has(String(s || "").toUpperCase());

  // Ambient `fastn` global — connector calls route to the installation's connections.
  const input = ctx.input || {};
  const directDealIds = (input.dealId != null ? [String(input.dealId)] : []).concat(Array.isArray(input.dealIds) ? input.dealIds.map(String) : []);
  const isManual = directDealIds.length > 0 || input.limit != null || input.maxPages != null || input.modifiedSince != null;
  const limit = Number(input.limit) || 100;
  const maxPages = Number(input.maxPages) || 1000;

  // Installation-aware config resolution (installation clone -> template fallback)
  const hasEntities = (c) => c && (Array.isArray(c.entities) || Array.isArray(c.directions)) && ((c.entities || c.directions).length > 0);
  let config = {};
  try { if (fastn.config && typeof fastn.config.getByTemplate === "function") config = (await fastn.config.getByTemplate(TEMPLATE_ID)) || {}; } catch (e) { config = {}; }
  if (!hasEntities(config)) { try { const t = await fastn.config.get(TEMPLATE_ID); if (hasEntities(t)) config = t; } catch (e) {} }
  const flows = config.entities ?? config.directions ?? [];

  // Canonical orientation: the Sale/Deal entity is stored source=cin7core, target=hubspot.
  const dir = flows.find(d =>
    (d.source?.entity ?? d.sourceEntity) === "sale" && (d.source?.connector ?? d.sourceConnector) === "cin7core" &&
    (d.target?.entity ?? d.targetEntity) === "deal" && (d.target?.connector ?? d.targetConnector) === "hubspot");
  if (!dir) return { error: "sale entity not found in config", created:0, updated:0, skipped:0, errors:0, errorDetails:[] };
  // Normalize to HubSpot(source) -> Cin7(target) for this inbound flow: reverse 'both', keep 'inbound', skip 'outbound'.
  const rawMaps = dir.mappings || [];
  const mappings = [];
  for (const mp of rawMaps) {
    const d = mp.syncDirection || "both";
    if (d === "outbound") continue;
    if (d === "both") mappings.push({ ...mp, sourceField: mp.targetField, sourceLabel: mp.targetLabel, targetField: mp.sourceField, targetLabel: mp.sourceLabel });
    else mappings.push(mp);
  }
  const conditions = dir.conditions || [];

  const HEADER_TARGETS = { TaxRule:"TaxRule", Location:"Location", Type:"SaleType", SaleType:"SaleType", BaseCurrency:"BaseCurrency", PaymentTerm:"Terms", Terms:"Terms", CustomerReference:"CustomerReference", PriceTier:"PriceTier", SalesRepresentative:"SalesRepresentative" };
  const normSaleType = (v) => String(v || "").toLowerCase().includes("advanced") ? "Advanced" : "Simple";
  const TAX_RULE_FALLBACK = "CA-Kern-Kern (Sale)";
  const LOCATION_FALLBACK = "Main Warehouse";
  const SALES_REP_FALLBACK = "Matthew ";
  const ORDER_STATUS = "DRAFT";

  let _ownersById = null;
  async function ownersById(){
    if (_ownersById) return _ownersById;
    _ownersById = {};
    try { const o = await fastn.connector.hubspot.listOwners({ limit: 100 });
      for (const ow of (o.output?.results || [])){ const nm=[ow.firstName,ow.lastName].filter(Boolean).join(" ").trim()||ow.email||null; if(ow.id!=null&&nm) _ownersById[String(ow.id)]=nm; } } catch(e){}
    return _ownersById;
  }
  let _ownersByUserId = null;
  async function ownersByUserId(){
    if (_ownersByUserId) return _ownersByUserId;
    _ownersByUserId = {};
    try { const owners = await fastn.connector.hubspot.listOwners({ limit: 100 });
      for (const o of (owners.output?.results || [])){ const nm=[o.firstName,o.lastName].filter(Boolean).join(" ").trim()||o.email||null; if(o.userId!=null&&nm) _ownersByUserId[String(o.userId)]=nm; } } catch(e){}
    return _ownersByUserId;
  }
  async function resolveCreatorRep(deal){ const uid=prop(deal,"hs_created_by_user_id"); if(!uid) return null; const map=await ownersByUserId(); return map[String(uid)]||null; }

  async function mapVal(m, deal){
    const sf = m.sourceField || "";
    let v = sf.startsWith("__fixed:") ? sf.slice(8) : prop(deal, sf);
    if (v == null || v === "") return null;
    if (sf === "hubspot_owner_id"){ const map = await ownersById(); v = map[String(v)] || null; }
    return v;
  }
  async function buildHeader(deal){
    const h = {};
    for (const m of mappings){
      const tgt = HEADER_TARGETS[m.targetField]; if (!tgt) continue;
      const val = await mapVal(m, deal); if (val == null) continue;
      h[tgt] = (tgt === "SaleType") ? normSaleType(val) : String(val);
    }
    // Self-heal tenant-sensitive header fields: configured values that do not exist
    // in this Cin7 account's reference books would 404 every write, so replace them
    // with the account's own defaults (valid configured values are kept).
    const refs = await tenantRefs();
    if (h.Location && refs.locations.length && !refs.locations.includes(h.Location)) h.Location = refs.defaultLocation || refs.locations[0];
    if (h.Terms && refs.terms.length && !refs.terms.includes(h.Terms)) h.Terms = refs.defaultTerm || refs.terms[0];
    if (h.TaxRule && h.TaxRule !== "Auto Look Up" && refs.taxes.length && !refs.taxes.includes(h.TaxRule)) h.TaxRule = "Auto Look Up";
    return h;
  }

  let _tenantRefs = null;
  async function tenantRefs(){
    if (_tenantRefs) return _tenantRefs;
    const refs = { locations: [], defaultLocation: null, terms: [], defaultTerm: null, taxes: [] };
    try { const r = await fastn.connector.cin7core.listLocations({ Limit: 100 }); const L = ((r.output && r.output.LocationList) || []).filter(l => !l.IsDeprecated); refs.locations = L.map(l => l.Name); const d = L.find(l => l.IsDefault); refs.defaultLocation = d ? d.Name : null; } catch (e) {}
    try { const r = await fastn.connector.cin7core.listPaymentTerms({ Limit: 100 }); const T = ((r.output && r.output.PaymentTermList) || []).filter(t => t.IsActive !== false); refs.terms = T.map(t => t.Name); const d = T.find(t => t.IsDefault); refs.defaultTerm = d ? d.Name : null; } catch (e) {}
    try { const r = await fastn.connector.cin7core.listTaxes({ Limit: 100 }); const X = (r.output && (r.output.TaxList || r.output.Taxes || r.output.TaxRuleList)) || []; refs.taxes = X.map(t => t.Name); } catch (e) {}
    _tenantRefs = refs; return refs;
  }

  let _hubPortalId = null;
  async function hubPortalId(){
    if (_hubPortalId !== null) return _hubPortalId;
    try { const t = await fastn.connector.hubspot.getUserToken({}); _hubPortalId = t.output?.hub_id ? String(t.output.hub_id) : ""; }
    catch(e){ _hubPortalId = ""; }
    return _hubPortalId;
  }

  const elig = (config.eligibility && config.eligibility.deal) || {};
  const included = Array.isArray(elig.included) ? elig.included : [];
  const excluded = Array.isArray(elig.excluded) ? elig.excluded : [];
  function eligible(id){ if (included.length && !included.includes(id)) return false; if (excluded.length && excluded.includes(id)) return false; return true; }

  function prop(rec, name){ if (name === "hs_object_id") return rec.id; return rec?.properties?.[name]; }
  function evalConditions(rec){
    for (const c of conditions){
      const v = prop(rec, c.field);
      if (v === undefined) continue; // Cin7-side condition (field absent on HubSpot record) does not apply here
      const op = c.operator; const target = c.value;
      if ((target == null || target === "") && op !== "is_empty" && op !== "is_not_empty") continue;
      const pass = op==="equals"?String(v)===String(target):op==="not_equals"?String(v)!==String(target)
        :op==="contains"?String(v??"").includes(target):op==="is_empty"?!v:op==="is_not_empty"?!!v
        :op==="in"?String(target).split(",").map(s=>s.trim()).includes(String(v)):op==="not_in"?!String(target).split(",").map(s=>s.trim()).includes(String(v)):true;
      if (!pass) return `field '${c.field}' is ${JSON.stringify(v ?? null)} but must ${op} '${target ?? ""}'`;
    }
    return null;
  }

  async function resolveCustomerId(deal){
    const direct = prop(deal, "cin7_customer_id");
    if (direct) return { customerId: direct, via: "deal.cin7_customer_id" };
    try {
      const ac = await fastn.connector.hubspot.listAssociations({ fromObjectType:"deals", fromObjectId:String(deal.id), toObjectType:"companies", limit:1 });
      const compId = ac.output?.results?.[0]?.toObjectId;
      if (compId){ const m = await fastn.state.get(COMPANY_IDMAP(compId)); if (m) return { customerId: m, via: "company idmap" }; }
    } catch(e){}
    try {
      const at = await fastn.connector.hubspot.listAssociations({ fromObjectType:"deals", fromObjectId:String(deal.id), toObjectType:"contacts", limit:1 });
      const ctId = at.output?.results?.[0]?.toObjectId;
      if (ctId){
        const ct = await fastn.connector.hubspot.getContact({ contactId:String(ctId), properties:["cin7_parent_customer_id"] }).catch(()=>null);
        const pc = ct?.output?.properties?.cin7_parent_customer_id;
        if (pc) return { customerId: pc, via: "contact.cin7_parent_customer_id" };
      }
    } catch(e){}
    return { customerId: null, via: null };
  }

  function normName(s){ return String(s||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim(); }
  async function matchCin7Product(sku, name){
    if (sku){
      const bySku = await fastn.connector.cin7core.listProducts({ Sku: String(sku), Limit: 1 }).catch(()=>null);
      const ps = bySku?.output?.Products || [];
      if (ps.length) return ps[0];
    }
    if (!name) return null;
    const want = normName(name);
    let r = await fastn.connector.cin7core.listProducts({ Name: name, Limit: 5 }).catch(()=>null);
    let prods = r?.output?.Products || [];
    let hit = prods.find(p => normName(p.Name) === want);
    if (hit) return hit;
    const toks = String(name).split(/\s+/).filter(Boolean);
    for (const pre of [toks.slice(0,2).join(" "), toks[0]]){
      if (!pre) continue;
      r = await fastn.connector.cin7core.listProducts({ Name: pre, Limit: 20 }).catch(()=>null);
      prods = r?.output?.Products || [];
      hit = prods.find(p => normName(p.Name) === want);
      if (hit) return hit;
      hit = prods.find(p => normName(p.Name).startsWith(want) || want.startsWith(normName(p.Name)));
      if (hit) return hit;
    }
    return null;
  }

  async function buildOrderLines(deal, taxRule){
    const orderLines = [], unmatched = [];
    try {
      const li = await fastn.connector.hubspot.listAssociations({ fromObjectType:"deals", fromObjectId:String(deal.id), toObjectType:"line_items", limit:50 }).catch(()=>null);
      const liIds = (li?.output?.results||[]).map(x=>x.toObjectId).filter(Boolean);
      for (const liId of liIds){
        const liRec = await fastn.connector.hubspot.getLineItem({ lineItemId:String(liId), properties:["hs_sku","name","price","quantity","hs_product_id"] }).catch(()=>null);
        const lp = liRec?.output?.properties || {};
        let prod = null;
        if (lp.hs_product_id){
          const mappedId = await fastn.state.get(PRODUCT_IDMAP(lp.hs_product_id)).catch(()=>null);
          if (mappedId){
            const byId = await fastn.connector.cin7core.listProducts({ ID: String(mappedId), Limit: 1 }).catch(()=>null);
            prod = byId?.output?.Products?.[0] || null;
          }
        }
        if (!prod) prod = await matchCin7Product(lp.hs_sku, lp.name);
        if (!prod){ unmatched.push(lp.name || liId); continue; }
        const qty = Number(lp.quantity) || 1;
        const price = Number(lp.price) || 0;
        orderLines.push({ ProductID: prod.ID, SKU: prod.SKU, Name: prod.Name, Quantity: qty, Price: price, Discount: 0, Tax: 0, Total: qty * price, TaxRule: taxRule });
      }
    } catch(e){}
    return { orderLines, unmatched };
  }
  const lineSignature = (lines) => lines.map(l => `${l.ProductID}x${l.Quantity}@${l.Price}`).sort().join("|");

  const result = { created:0, updated:0, skipped:0, errors:0, errorDetails:[], skippedDetails:[] };
  const skip = (deal, reason, extra) => {
    result.skipped++;
    const entry = { sourceId: deal?.id ?? null, dealName: deal ? (prop(deal, "dealname") || null) : null, reason, ...(extra || {}) };
    result.skippedDetails.push(entry);
    console.log(`[SKIP] deal ${entry.sourceId}${entry.dealName ? ` "${entry.dealName}"` : ""} — ${reason}`);
  };
  const cursorIso = isManual ? (input.modifiedSince || null) : (await fastn.state.get(CURSOR_KEY) || null);
  let newCursorMax = cursorIso;
  let after = "0";
  let pages = 0;

  while (pages < maxPages){
    const sr = { filterGroups: [], sorts: [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }], query: "", properties: ["dealname","amount","description","dealstage","pipeline","cin7_customer_id","cin7_sale_id","hs_lastmodifieddate","hs_created_by_user_id","hubspot_owner_id"], limit, after };
    if (directDealIds.length) sr.filterGroups = [{ filters: [{ propertyName: "hs_object_id", operator: "IN", values: directDealIds }] }];
    else if (cursorIso) sr.filterGroups = [{ filters: [{ propertyName: "hs_lastmodifieddate", operator: "GT", value: String(new Date(cursorIso).getTime()) }] }];
    let resp;
    try { resp = await fastn.connector.hubspot.searchDeals(sr); }
    catch(e){ result.errors++; result.errorDetails.push({ reason:"searchDeals failed", errorMessage:String(e).slice(0,200) }); break; }
    const deals = resp.output?.results || [];
    if (deals.length === 0) break;

    for (const deal of deals){
      try {
        const lm = prop(deal, "hs_lastmodifieddate");
        if (lm && (!newCursorMax || new Date(lm) > new Date(newCursorMax))) newCursorMax = lm;
        if (!eligible(deal.id)) { skip(deal, "excluded by the sync eligibility list in the config"); continue; }
        const condFail = evalConditions(deal);
        if (condFail) { skip(deal, "config filter not met: " + condFail); continue; }

        const { customerId, via } = await resolveCustomerId(deal);
        if (!customerId){ skip(deal, "no resolvable Cin7 customer — deal has no cin7_customer_id, its company is not synced to Cin7, and its contact has no cin7_parent_customer_id"); continue; }

        const customerRef = prop(deal,"description") || prop(deal,"dealname") || ("HS Deal " + deal.id);
        const header = await buildHeader(deal);
        const TAX_RULE = header.TaxRule || TAX_RULE_FALLBACK;
        const LOCATION = header.Location || LOCATION_FALLBACK;
        const SALE_TYPE = header.SaleType || "Simple";
        const salesRep = header.SalesRepresentative || await resolveCreatorRep(deal) || SALES_REP_FALLBACK;
        const portalId = await hubPortalId();
        const dealUrl = portalId ? `https://app.hubspot.com/contacts/${portalId}/record/0-3/${deal.id}` : null;

        const { orderLines, unmatched } = await buildOrderLines(deal, TAX_RULE);
        const hashVal = JSON.stringify({ customerId, customerRef, header, status: ORDER_STATUS, salesRep, note: dealUrl, lines: lineSignature(orderLines) });
        const priorHash = await fastn.state.get(HASH(deal.id));

        let saleId = await fastn.state.get(IDMAP(deal.id));
        if (!saleId){
          const stamped = prop(deal, "cin7_sale_id");
          if (stamped){
            const chk = await fastn.connector.cin7core.getSale({ ID: String(stamped) }).catch(()=>null);
            if (chk?.output?.ID){ saleId = String(stamped); await fastn.state.set(IDMAP(deal.id), saleId); }
          }
        }
        if (saleId && priorHash === hashVal) { skip(deal, "already synced and unchanged since the last sync (nothing to update)", { saleId: String(saleId) }); continue; }

        if (saleId){
          let sale = null;
          try { const r = await fastn.connector.cin7core.getSale({ ID: String(saleId) }); sale = r.output || null; } catch(e){}
          if (!sale){
            result.errors++; result.errorDetails.push({ sourceId: deal.id, saleId, reason:"existing mapped sale not found on update" });
            await fastn.state.set(HASH(deal.id), hashVal);
            continue;
          }
          const st = String(sale.Status || "").toUpperCase();
          if (!isEditable(st)){
            skip(deal, `mapped Cin7 sale is ${st}; Cin7 will not rewrite an authorised/voided sale — header & line updates skipped`, { saleId: String(saleId) });
            await fastn.state.set(HASH(deal.id), hashVal);
            continue;
          }
          try {
            const upd = {
              ID: String(saleId),
              Customer: sale.Customer,
              CustomerID: sale.CustomerID || customerId,
              Location: LOCATION || sale.Location || LOCATION_FALLBACK,
              TaxRule: TAX_RULE,
              CustomerReference: customerRef,
              SalesRepresentative: salesRep,
              Note: dealUrl || sale.Note
            };
            if (header.Terms) upd.Terms = header.Terms;
            await fastn.connector.cin7core.updateSale(upd);
          } catch(e){ result.errors++; result.errorDetails.push({ sourceId: deal.id, saleId, reason:"updateSale (header) failed", errorMessage:String(e).slice(0,200) }); }
          let lineWriteFailed = false;
          if (orderLines.length){
            const ord = await fastn.connector.cin7core.createSaleOrder({ SaleID: String(saleId), Status: "DRAFT", Memo: "Line items re-synced from HubSpot deal", Lines: orderLines }).catch(e=>({ __err: String(e).slice(0,200) }));
            if (ord && ord.__err){ lineWriteFailed = true; result.errorDetails.push({ sourceId: deal.id, saleId, reason:"createSaleOrder (update) failed", errorMessage: ord.__err }); }
          } else {
            result.errorDetails.push({ sourceId: deal.id, saleId, reason:"update had no matched line items; existing Cin7 order lines left unchanged", unmatched });
          }
          if (unmatched.length){ result.errorDetails.push({ sourceId: deal.id, saleId, reason:"line items with no Cin7 product match (skipped)", unmatched }); }
          result.updated++;
          if (!lineWriteFailed) await fastn.state.set(HASH(deal.id), hashVal);
          await fastn.state.set(SALE_IDMAP(saleId), String(deal.id));
          continue;
        }

        const saleBody = {
          CustomerID: customerId,
          Location: LOCATION,
          SaleType: SALE_TYPE,
          SkipQuote: true,
          TaxInclusive: false,
          TaxRule: TAX_RULE,
          CurrencyRate: 1,
          CustomerReference: customerRef
        };
        if (header.BaseCurrency) saleBody.BaseCurrency = header.BaseCurrency;
        if (header.Terms) saleBody.Terms = header.Terms;
        if (header.PriceTier) saleBody.PriceTier = header.PriceTier;
        if (salesRep) saleBody.SalesRepresentative = salesRep;
        if (dealUrl) saleBody.Note = dealUrl;
        const lateMapped = await fastn.state.get(IDMAP(deal.id));
        if (lateMapped){ skip(deal, "a concurrent run already created the sale for this deal (idmap set mid-run)", { saleId: String(lateMapped) }); continue; }
        const CLOCK = `c7hs:lock:dealcreate:${deal.id}`;
        const runTag = Date.now() + "-" + Math.random().toString(36).slice(2,10);
        const priorLock = await fastn.state.get(CLOCK);
        const priorTs = priorLock ? Number(String(priorLock).split("-")[0]) : 0;
        if (priorTs && (Date.now() - priorTs) < 120000) { skip(deal, "a concurrent run holds the sale-create lock for this deal — that run creates the sale"); continue; }
        await fastn.state.set(CLOCK, runTag);
        { const _s = Date.now(); while (Date.now() - _s < 800) {} }
        if ((await fastn.state.get(CLOCK)) !== runTag) { skip(deal, "lost the sale-create lock election to a concurrent run — that run creates the sale"); continue; }
        const lateMappedFinal = await fastn.state.get(IDMAP(deal.id));
        if (lateMappedFinal) { skip(deal, "sale already created by a concurrent run (idmap set after winning lock)", { saleId: String(lateMappedFinal) }); continue; }
        let created;
        try { created = await fastn.connector.cin7core.createSale(saleBody); }
        catch(e){
          const msg = String(e);
          if (/taxation rule/i.test(msg) && saleBody.TaxRule !== TAX_RULE_FALLBACK){
            result.errorDetails.push({ sourceId: deal.id, reason:`configured TaxRule '${saleBody.TaxRule}' is not an active Cin7 sale tax rule; created with fallback '${TAX_RULE_FALLBACK}'. Fix the Tax Rule selection in the widget config.` });
            saleBody.TaxRule = TAX_RULE_FALLBACK;
            try { created = await fastn.connector.cin7core.createSale(saleBody); }
            catch(e2){ result.errors++; result.errorDetails.push({ sourceId: deal.id, reason:"createSale failed after tax-rule fallback", via, errorMessage:String(e2).slice(0,200) }); continue; }
          } else {
            result.errors++; result.errorDetails.push({ sourceId: deal.id, reason:"createSale failed", via, errorMessage:msg.slice(0,200) }); continue;
          }
        }
        saleId = created.output?.ID;
        if (!saleId){ result.errors++; result.errorDetails.push({ sourceId: deal.id, reason:"createSale returned no ID" }); continue; }
        let verifiedSale = null;
        try { const vr = await fastn.connector.cin7core.getSale({ ID: String(saleId) }); verifiedSale = vr.output || null; } catch(e){}
        if (!verifiedSale?.ID){
          result.errors++; result.errorDetails.push({ sourceId: deal.id, saleId: String(saleId), reason:"createSale returned an ID but getSale could not confirm the sale exists; NOT counted as created, idmap/back-stamp not written" });
          continue;
        }
        result.created++;
        await fastn.state.set(IDMAP(deal.id), String(saleId));
        const orderNumber = created.output?.Order?.SaleOrderNumber || verifiedSale.Order?.SaleOrderNumber || "";

        if (orderLines.length){
          const ord = await fastn.connector.cin7core.createSaleOrder({ SaleID: String(saleId), Status: "DRAFT", Memo: "Line items synced from HubSpot deal", Lines: orderLines }).catch(e=>({ __err: String(e).slice(0,200) }));
          if (ord && ord.__err){ result.errorDetails.push({ sourceId: deal.id, reason:"createSaleOrder failed (sale created without lines)", errorMessage: ord.__err }); }
        }
        if (unmatched.length){ result.errorDetails.push({ sourceId: deal.id, reason:"line items with no Cin7 product match (skipped)", unmatched }); }

        await fastn.state.set(IDMAP(deal.id), String(saleId));
        await fastn.state.set(HASH(deal.id), hashVal);

        try { await fastn.connector.hubspot.updateDeal({ dealId: String(deal.id), properties: { cin7_sale_id: String(saleId), cin7_order_number: orderNumber } }); }
        catch(e){ result.errorDetails.push({ sourceId: deal.id, saleId, reason:"back-stamp cin7_sale_id failed (non-fatal)", errorMessage:String(e).slice(0,150) }); }
        await fastn.state.set(SALE_IDMAP(saleId), String(deal.id));
        await fastn.state.set(SALE_LINES_DONE(saleId), "1");
      } catch(e){ result.errors++; result.errorDetails.push({ sourceId: deal.id, reason:"sync failed", errorMessage:String(e).slice(0,200) }); }
    }
    const next = resp.output?.paging?.next?.after;
    if (!next) break;
    after = next; pages++;
  }
  if (!isManual && newCursorMax) await fastn.state.set(CURSOR_KEY, newCursorMax);
  return result;
}