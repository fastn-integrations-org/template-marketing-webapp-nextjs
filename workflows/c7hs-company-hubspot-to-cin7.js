export default async function (ctx) {
  const TEMPLATE_ID = "cfg_0a958721d430"; // getByTemplate resolves the installation's clone
  const CURSOR_KEY = "c7hs:cursor:company:hubspot-to-cin7";
  const IDMAP = (id) => `c7hs:idmap:company:h2c:${id}`;
  const HASH = (id) => `c7hs:hash:company:h2c:${id}`;
  const REV_IDMAP = (cin7Id) => `c7hs:idmap:customer:c2h:${cin7Id}`;
  const CIDMAP = (hsId) => `c7hs:idmap:contacthsid:h2c:${hsId}`;

  // Ambient `fastn` global — connector calls route to the installation's connections.
  const input = ctx.input || {};
  const directIds = (input.companyId != null ? [String(input.companyId)] : [])
    .concat(Array.isArray(input.companyIds) ? input.companyIds.map(String) : []);
  const isDirect = directIds.length > 0;
  const isManual = isDirect || input.limit != null || input.maxPages != null || input.modifiedSince != null;
  const limit = Number(input.limit) || 100;
  const maxPages = Number(input.maxPages) || 1000;

  // Installation-aware config resolution (installation clone -> template fallback)
  const hasEntities = (c) => c && (Array.isArray(c.entities) || Array.isArray(c.directions)) && ((c.entities || c.directions).length > 0);
  let config = {};
  try { if (fastn.config && typeof fastn.config.getByTemplate === "function") config = (await fastn.config.getByTemplate(TEMPLATE_ID)) || {}; } catch (e) { config = {}; }
  if (!hasEntities(config)) { try { const t = await fastn.config.get(TEMPLATE_ID); if (hasEntities(t)) config = t; } catch (e) {} }
  const flows = config.entities ?? config.directions ?? [];

  // New config stores each object canonically as source=cin7core, target=hubspot.
  // This is the HubSpot -> Cin7 (inbound) flow, so find the Customer/Company entity by canonical orientation.
  const dir = flows.find(d =>
    (d.source?.entity ?? d.sourceEntity) === "customer" && (d.source?.connector ?? d.sourceConnector) === "cin7core" &&
    (d.target?.entity ?? d.targetEntity) === "company" && (d.target?.connector ?? d.targetConnector) === "hubspot");
  if (!dir) return { error: "customer/company entity not found in config", created:0, updated:0, skipped:0, errors:0, errorDetails:[] };
  // Normalize to HubSpot(source) -> Cin7(target) orientation for this inbound flow:
  //  'both' -> reverse (hubspot targetField becomes source, cin7 sourceField becomes target);
  //  'inbound' -> already hubspot/fixed(source) -> cin7(target); 'outbound' -> skip.
  const rawMaps = dir.mappings || [];
  const mappings = [];
  for (const mp of rawMaps) {
    const d = mp.syncDirection || "both";
    if (d === "outbound") continue;
    if (d === "both") mappings.push({ ...mp, sourceField: mp.targetField, sourceLabel: mp.targetLabel, targetField: mp.sourceField, targetLabel: mp.sourceLabel });
    else mappings.push(mp);
  }
  const conditions = dir.conditions || [];

  const cd = config.cin7Defaults || {};
  // Resolve tenant-valid defaults from the connected Cin7 account: config values are
  // honored when they exist in the account's reference books; otherwise fall back to
  // the account's own defaults (never foreign-tenant literals).
  let _acct = {}, _terms = [], _arAccts = [], _revAccts = [], _tiers = [], _taxes = [];
  try { const r = await fastn.connector.cin7core.listTaxes({}); if (r.success) { const o = r.output || {}; _taxes = o.TaxationRules || o.SaleTaxRules || o.TaxRules || o.Taxes || (Array.isArray(o) ? o : (Object.values(o).find(v => Array.isArray(v)) || [])); } } catch (e) {}
  try { const r = await fastn.connector.cin7core.getMe({}); if (r.success) _acct = r.output || {}; } catch (e) {}
  try { const r = await fastn.connector.cin7core.listPaymentTerms({ Limit: 100 }); if (r.success) _terms = (r.output && r.output.PaymentTermList) || []; } catch (e) {}
  try { const r = await fastn.connector.cin7core.listAccountReceivable({ Limit: 100 }); if (r.success) _arAccts = (r.output && r.output.AccountsList) || []; } catch (e) {}
  try { const r = await fastn.connector.cin7core.listRevenueAccount({ Limit: 100 }); if (r.success) _revAccts = (r.output && r.output.AccountsList) || []; } catch (e) {}
  try { const r = await fastn.connector.cin7core.listPriceTiers({}); if (r.success) _tiers = (r.output && r.output.PriceTiers) || []; } catch (e) {}
  const _activeTerms = _terms.filter(t => t.IsActive !== false);
  const _termName = (_activeTerms.find(t => t.Name === cd.paymentTerm) || _activeTerms.find(t => t.IsDefault) || _activeTerms[0] || {}).Name;
  const _activeTaxes = _taxes.filter(t => t && t.IsActive !== false);
  const _taxName = (_activeTaxes.find(t => String(t.Name) === String(cd.taxRule)) || _activeTaxes[0] || {}).Name;
  const _activeAr = _arAccts.filter(a => a.Status === "ACTIVE");
  const _arCode = (_activeAr.find(a => a.Code === cd.accountReceivable) || _activeAr.find(a => a.SystemAccountCode === "DEBTORS") || _activeAr[0] || {}).Code;
  const _activeRev = _revAccts.filter(a => a.Status === "ACTIVE");
  const _revCode = (_activeRev.find(a => a.Code === cd.revenueAccount) || _activeRev.find(a => a.Name === "Sales") || _activeRev.find(a => a.Type === "SALES") || _activeRev[0] || {}).Code;
  const _tierNames = _tiers.map(t => t.Name);
  const DEF = {
    Status: "Active",
    Currency: cd.baseCurrency || _acct.Currency || "USD",
    PaymentTerm: _termName || cd.paymentTerm || "Net 30",
    TaxRule: _taxName || cd.taxRule || "GST Standard Rate",
    AccountReceivable: _arCode || cd.accountReceivable || "1200",
    RevenueAccount: _revCode || cd.revenueAccount || "4000",
    PriceTier: (_tierNames.includes(cd.priceTier) ? cd.priceTier : _tierNames[0]) || "Tier 1"
  };
  const CUST_FIELDS = ["Status","Currency","PaymentTerm","TaxRule","AccountReceivable","RevenueAccount","PriceTier","SalesRepresentative","Tags","Comments","TaxNumber","CreditLimit","Discount","DisplayName","Carrier","Location"];
  // Contact JobTitle flows HubSpot->Cin7 only when the config's contact mapping allows it (syncDirection both/inbound).
  const JT_INBOUND = (() => { try {
    const ents = config.entities || [];
    const ce = ents.find(e => e && e.source && e.source.entity === "contact" && e.source.connector === "cin7core");
    const m = ce && (ce.mappings || []).find(x => x && (x.sourceField === "Contacts.JobTitle" || x.targetField === "jobtitle"));
    const d = (m && m.syncDirection) || "outbound";
    return d === "both" || d === "inbound";
  } catch (e) { return false; } })();

  const elig = (config.eligibility && config.eligibility.company) || {};
  const included = Array.isArray(elig.included) ? elig.included : [];
  const excluded = Array.isArray(elig.excluded) ? elig.excluded : [];
  function eligible(id){ if (included.length && !included.includes(id)) return false; if (excluded.length && excluded.includes(id)) return false; return true; }

  function normAddrType(t){ const s=String(t||"").toLowerCase(); if(s==="shipment"||s==="shipping")return "Shipping"; if(s==="billing")return "Billing"; if(s==="business")return "Business"; return t; }
  const ADDRESS_TYPE = normAddrType((conditions.find(c => c.field === "addressType") || {}).value) || "Billing";
  function prop(rec, name){ if (name === "hs_object_id") return rec.id; return rec?.properties?.[name]; }
  function evalConditions(rec){
    for (const c of conditions){
      if (c.field === "addressType") continue;
      const v = prop(rec, c.field);
      if (v === undefined) continue; // Cin7-side condition (field absent on the HubSpot record) does not apply here
      const op = c.operator; const target = c.value;
      const pass = op==="equals"?String(v)===String(target):op==="not_equals"?String(v)!==String(target)
        :op==="contains"?String(v??"").includes(target):op==="is_empty"?!v:op==="is_not_empty"?!!v
        :op==="in"?String(target).split(",").map(s=>s.trim()).includes(String(v)):op==="not_in"?!String(target).split(",").map(s=>s.trim()).includes(String(v)):true;
      if (!pass) return false;
    }
    return true;
  }
  function fixedOrProp(c, m){
    const sf = String(m.sourceField || "");
    if (sf.startsWith("__fixed:")) return sf.slice(8);
    const v = prop(c, sf);
    if (v != null && v !== "") return v;
    if (sf && String(m.sourceLabel || "") === sf) return sf;
    return undefined;
  }
  function buildBody(c){
    const props = c.properties || {};
    const addr = {};
    const fields = {};
    let customerName = null;
    for (const m of mappings){
      const tf = m.targetField || "";
      if (tf === "Name") { const v = prop(c, m.sourceField); if (v != null) customerName = v; }
      else if (tf.startsWith("Addresses.")) { const v = prop(c, m.sourceField); if (v != null) addr[tf.split(".")[1]] = v; }
      else if (CUST_FIELDS.includes(tf)) { const v = fixedOrProp(c, m); if (v != null && v !== "") fields[tf] = v; }
    }
    if (!customerName) customerName = props.name || ("HubSpot Company " + c.id);
    let addresses = [];
    if (Object.keys(addr).length){
      if (!addr.Line1) addr.Line1 = addr.City || customerName;
      if (!addr.Country) addr.Country = (config.cin7Defaults && config.cin7Defaults.country) || "United States";
      addresses = [{ Type: ADDRESS_TYPE, DefaultForType: true, ...addr }];
    }
    // Self-heal tenant-sensitive fields: a configured fixed value that does not exist
    // in this Cin7 account's reference books would 404 every write, so replace it with
    // the account's own default resolved at run start (valid configured values are kept).
    if (_activeTerms.length && fields.PaymentTerm !== undefined && !_activeTerms.some(t => t.Name === fields.PaymentTerm)) fields.PaymentTerm = DEF.PaymentTerm;
    if (_activeTaxes.length && fields.TaxRule !== undefined && !_activeTaxes.some(t => String(t.Name) === String(fields.TaxRule))) fields.TaxRule = DEF.TaxRule;
    if (_activeAr.length && fields.AccountReceivable !== undefined && !_activeAr.some(a => a.Code === String(fields.AccountReceivable))) fields.AccountReceivable = DEF.AccountReceivable;
    if (_activeRev.length && fields.RevenueAccount !== undefined && !_activeRev.some(a => a.Code === String(fields.RevenueAccount))) fields.RevenueAccount = DEF.RevenueAccount;
    if (_tierNames.length && fields.PriceTier !== undefined && !_tierNames.includes(fields.PriceTier)) fields.PriceTier = DEF.PriceTier;
    return { customerName, addresses, fields };
  }

  const normKey = (s) => String(s||"").trim().toLowerCase();
  async function filterTombstoned(list){
    const out = [];
    for (const ct of (list||[])){
      const em = String(ct?.Email||"").trim().toLowerCase();
      if (em){
        const ts = await fastn.state.get(`c7hs:tombstone:contact:${em}`).catch(()=>null);
        if (ts && (Date.now() - new Date(ts).getTime()) < 15*60*1000) continue;
      }
      out.push(ct);
    }
    return out;
  }
  async function buildContacts(companyId, existingContacts){
    const existing = Array.isArray(existingContacts) ? existingContacts : [];
    const byEmail = new Map(), byName = new Map();
    for (const ec of existing){ if (ec.Email) byEmail.set(normKey(ec.Email), ec); if (ec.Name) byName.set(normKey(ec.Name), ec); }
    const out = []; const seenEmail = new Set(), seenName = new Set();
    try {
      const a = await fastn.connector.hubspot.listAssociations({ fromObjectType:"companies", fromObjectId:String(companyId), toObjectType:"contacts", limit:25 });
      const ids = (a.output?.results||[]).map(x=>x.toObjectId).filter(Boolean);
      for (const cid of ids){
        const g = await fastn.connector.hubspot.getContact({ contactId:String(cid), properties:["firstname","lastname","email","phone","jobtitle"] }).catch(()=>null);
        const pr = g?.output?.properties; if (!pr) continue;
        const _cEnt=(config.entities||[]).find(e=>e&&e.source&&e.source.entity==="contact"); const _cm=_cEnt&&(_cEnt.mappings||[]).find(m=>m&&m.mappingMode==="combine"); const _cf=(_cm&&Array.isArray(_cm.combineFields)&&_cm.combineFields.length)?_cm.combineFields:["firstname","lastname"]; const _csep=(_cm&&_cm.combineSeparator!=null)?_cm.combineSeparator:" "; const nm = _cf.map(f=>pr[f]).filter(Boolean).join(_csep).trim();
        const email = pr.email || "";
        if (!nm && !email) continue;
        const ek = normKey(email), nk = normKey(nm || email);
        if (ek && seenEmail.has(ek)) continue;
        if (!ek && nk && seenName.has(nk)) continue;
        const match = (ek && byEmail.get(ek)) || (nk && byName.get(nk)) || null;
        const obj = { Name: nm || email, Email: email, Phone: pr.phone || "", Default: out.length===0, IncludeInEmail: false, __hsId: String(cid) };
        if (JT_INBOUND && pr.jobtitle != null && pr.jobtitle !== "") obj.JobTitle = String(pr.jobtitle).replace(/\\/g, " ").replace(/"/g, "'");
        if (match && match.ID) obj.ID = match.ID;
        out.push(obj);
        if (ek) seenEmail.add(ek); if (nk) seenName.add(nk);
      }
    } catch(e){}
    return out;
  }
  const cin7Contacts = (arr) => (arr||[]).map(({ __hsId, ...rest }) => rest);
  async function writeContactIndex(custId, contacts){
    for (const ct of (contacts||[])){
      if (!ct.__hsId) continue;
      try { await fastn.state.set(CIDMAP(ct.__hsId), JSON.stringify({ customerId: String(custId), email: ct.Email || "", name: ct.Name || "" })); } catch(e){}
    }
  }
  async function readCustomer(custId){
    try { const ex = await fastn.connector.cin7core.listCustomers({ ID:String(custId), Limit:1, IncludeDeprecated:true }); return ex.output?.CustomerList?.[0] || null; }
    catch(e){ return null; }
  }

  async function backStamp(hubspotCompanyId, cin7CustomerId){
    if (!hubspotCompanyId || !cin7CustomerId) return;
    try { await fastn.connector.hubspot.updateCompany({ companyId: String(hubspotCompanyId), properties: { cin7_external_company_id: String(cin7CustomerId) } }); } catch(e){}
    try { await fastn.state.set(REV_IDMAP(cin7CustomerId), String(hubspotCompanyId)); } catch(e){}
  }

  async function syncCompany(c, result){
    if (!eligible(c.id)) { result.skipped++; return; }
    if (!evalConditions(c)) { result.skipped++; return; }
    const { customerName, addresses, fields } = buildBody(c);
    let custId = await fastn.state.get(IDMAP(c.id));
    let existingContacts = [];
    if (custId){ const ex = await readCustomer(custId); existingContacts = ex?.Contacts || []; }
    const contacts = await filterTombstoned(await buildContacts(c.id, existingContacts));
    const hashContacts = contacts.map(x=>({ Name:x.Name, Email:x.Email, Phone:x.Phone, JobTitle:x.JobTitle, Default:x.Default }));
    const hashVal = JSON.stringify({ customerName, addresses, contacts: hashContacts, fields });
    const priorHash = await fastn.state.get(HASH(c.id));
    if (!isDirect && custId && priorHash === hashVal) {
      await backStamp(c.id, custId);
      await writeContactIndex(custId, contacts);
      result.skipped++; return;
    }

    if (custId){
      const body = { ID: custId, Name: customerName, ...DEF, ...fields };
      if (addresses.length) body.Addresses = addresses; if (contacts.length) body.Contacts = cin7Contacts(contacts);
      try { await fastn.connector.cin7core.updateCustomerFull({ body: JSON.stringify(body) }); result.updated++; }
      catch(e){
        if (String(e).includes("already exists")){
          const look = await fastn.connector.cin7core.listCustomers({ Name: customerName, Limit: 1 }).catch(()=>null);
          const ex = look?.output?.CustomerList?.[0];
          if (ex?.ID){ custId = ex.ID; const ec = await filterTombstoned(await buildContacts(c.id, ex.Contacts||[])); const b2 = { ID: custId, Name: customerName, ...DEF, ...fields }; if (addresses.length) b2.Addresses = addresses; if (ec.length) b2.Contacts = cin7Contacts(ec); await fastn.connector.cin7core.updateCustomerFull({ body: JSON.stringify(b2) }); result.updated++; }
          else throw e;
        } else throw e;
      }
    } else {
      const body = { Name: customerName, ...DEF, ...fields };
      if (addresses.length) body.Addresses = addresses; if (contacts.length) body.Contacts = cin7Contacts(contacts);
      try { const cr = await fastn.connector.cin7core.createCustomerFull({ body: JSON.stringify(body) }); custId = cr.output?.CustomerList?.[0]?.ID; result.created++; }
      catch(e){
        if (String(e).includes("already exists")){
          const look = await fastn.connector.cin7core.listCustomers({ Name: customerName, Limit: 1 }).catch(()=>null);
          const ex = look?.output?.CustomerList?.[0];
          if (ex?.ID){ custId = ex.ID; const ec = await filterTombstoned(await buildContacts(c.id, ex.Contacts||[])); const b2 = { ID: custId, Name: customerName, ...DEF, ...fields }; if (addresses.length) b2.Addresses = addresses; if (ec.length) b2.Contacts = cin7Contacts(ec); await fastn.connector.cin7core.updateCustomerFull({ body: JSON.stringify(b2) }); result.updated++; }
          else throw e;
        } else throw e;
      }
    }
    if (custId){
      await fastn.state.set(IDMAP(c.id), String(custId));
      await fastn.state.set(HASH(c.id), hashVal);
      await backStamp(c.id, custId);
      await writeContactIndex(custId, contacts);
    }
  }

  const result = { created:0, updated:0, skipped:0, errors:0, errorDetails:[] };

  if (isDirect){
    const baseProps = ["name","city","state","zip","country","hs_object_id","hs_lastmodifieddate"];
    const mapProps = mappings.map(m => String(m.sourceField||"")).filter(sf => sf && !sf.startsWith("__fixed:") && !/\s/.test(sf));
    const PROPS = Array.from(new Set([...baseProps, ...mapProps]));
    for (const id of directIds){
      try {
        const g = await fastn.connector.hubspot.getCompany({ companyId: String(id), properties: PROPS }).catch(()=>null);
        const c = g?.output;
        if (!c || !c.id) { result.skipped++; result.errorDetails.push({ sourceId:id, reason:"company not found (maybe deleted)" }); continue; }
        await syncCompany(c, result);
      } catch(e){ result.errors++; result.errorDetails.push({ sourceId:id, reason:"direct sync failed", errorMessage:String(e).slice(0,200) }); }
    }
    return { ...result, mode:"direct", companyIds: directIds };
  }

  const baseProps = ["name","city","state","zip","country","hs_object_id","hs_lastmodifieddate"];
  const mapProps = mappings.map(m => String(m.sourceField||"")).filter(sf => sf && !sf.startsWith("__fixed:") && !/\s/.test(sf));
  const SEARCH_PROPS = Array.from(new Set([...baseProps, ...mapProps]));
  const cursorIso = isManual ? (input.modifiedSince || null) : (await fastn.state.get(CURSOR_KEY) || null);
  let newCursorMax = cursorIso;
  let after = "0";
  let pages = 0;
  while (pages < maxPages){
    const sr = { filterGroups: [], sorts: [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }], query: "", properties: SEARCH_PROPS, limit, after };
    if (cursorIso) sr.filterGroups = [{ filters: [{ propertyName: "hs_lastmodifieddate", operator: "GT", value: String(new Date(cursorIso).getTime()) }] }];
    let resp;
    try { resp = await fastn.connector.hubspot.searchCompanies(sr); }
    catch(e){ result.errors++; result.errorDetails.push({ reason:"searchCompanies failed", errorMessage:String(e).slice(0,200) }); break; }
    const companies = resp.output?.results || [];
    if (companies.length === 0) break;
    for (const c of companies){
      try {
        const lm = prop(c, "hs_lastmodifieddate");
        if (lm && (!newCursorMax || new Date(lm) > new Date(newCursorMax))) newCursorMax = lm;
        await syncCompany(c, result);
      } catch(e){ result.errors++; result.errorDetails.push({ sourceId: c.id, reason:"sync failed", errorMessage:String(e).slice(0,200) }); }
    }
    const next = resp.output?.paging?.next?.after;
    if (!next) break;
    after = next; pages++;
  }
  if (!isManual && newCursorMax) await fastn.state.set(CURSOR_KEY, newCursorMax);
  return result;
}