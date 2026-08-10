export default async function (ctx) {
  const TEMPLATE_ID = "cfg_0a958721d430"; // getByTemplate resolves the installation's clone
  const SOURCE_ENTITY = "sale", SOURCE_CONN = "cin7core";
  const TARGET_ENTITY = "deal", TARGET_CONN = "hubspot";
  const CURSOR_KEY = "c7hs:cursor:sale:cin7-to-hubspot";
  const IDMAP = (id) => `c7hs:idmap:sale:c2h:${id}`;
  const HASH = (id) => `c7hs:hash:sale:c2h:${id}`;
  const CUST_IDMAP = (id) => `c7hs:idmap:customer:c2h:${id}`;
  const CONTACT_IDMAP = (id) => `c7hs:idmap:contact:c2h:${id}`;

  // Ambient `fastn` global — connector calls route to the installation's connections.
  const input = ctx.input || {};
  const isManual = input.limit != null || input.maxPages != null || input.modifiedSince != null;
  const limit = Number(input.limit) || 100;
  const maxPages = Number(input.maxPages) || 1000;

  // Installation-aware config resolution (installation clone -> template fallback)
  const hasEntities = (c) => c && (Array.isArray(c.entities) || Array.isArray(c.directions)) && ((c.entities || c.directions).length > 0);
  let config = {};
  try { if (fastn.config && typeof fastn.config.getByTemplate === "function") config = (await fastn.config.getByTemplate(TEMPLATE_ID)) || {}; } catch (e) { config = {}; }
  if (!hasEntities(config)) { try { const t = await fastn.config.get(TEMPLATE_ID); if (hasEntities(t)) config = t; } catch (e) {} }
  const flows = config.entities ?? config.directions ?? [];

  const dir = flows.find(d =>
    (d.source?.entity ?? d.sourceEntity) === SOURCE_ENTITY && (d.source?.connector ?? d.sourceConnector) === SOURCE_CONN &&
    (d.target?.entity ?? d.targetEntity) === TARGET_ENTITY && (d.target?.connector ?? d.targetConnector) === TARGET_CONN);
  if (!dir) return { error: "sale entity not found in config", created:0, updated:0, skipped:0, errors:0, errorDetails:[] };
  // Outbound (Cin7 -> HubSpot): use 'both' + 'outbound' as-is; skip 'inbound'-only.
  const mappings = (dir.mappings || []).filter(m => (m.syncDirection || "both") !== "inbound");
  const conditions = dir.conditions || [];

  const elig = (config.eligibility && config.eligibility.sale) || {};
  const included = Array.isArray(elig.included) ? elig.included : [];
  const excluded = Array.isArray(elig.excluded) ? elig.excluded : [];
  function eligible(id){ if (included.length && !included.includes(id)) return false; if (excluded.length && excluded.includes(id)) return false; return true; }

  // Cin7 Status -> HubSpot deal stage, from the config's dealstage->status entity (inverted).
  const stageEntity = flows.find(d => (d.source?.entity ?? d.sourceEntity) === "dealstage" && (d.target?.entity ?? d.targetEntity) === "status");
  const stageMap = {};
  for (const sm of (stageEntity?.mappings || [])){ if (sm.targetField != null && sm.sourceField != null) stageMap[String(sm.targetField).toUpperCase()] = sm.sourceField; }
  function mapStage(status){ const m = stageMap[String(status || "").toUpperCase()]; return m || "appointmentscheduled"; }

  function evalConditions(rec){
    for (const c of conditions){
      const v = rec[c.field]; const op = c.operator; const target = c.value;
      const pass = op==="equals"?String(v)===String(target):op==="not_equals"?String(v)!==String(target)
        :op==="contains"?String(v??"").includes(target):op==="is_empty"?!v:op==="is_not_empty"?!!v
        :op==="in"?String(target).split(",").map(s=>s.trim()).includes(String(v)):op==="not_in"?!String(target).split(",").map(s=>s.trim()).includes(String(v)):true;
      if (!pass) return `field '${c.field}' is ${JSON.stringify(v ?? null)} but must ${op} '${target ?? ""}'`;
    }
    return null;
  }

  async function assoc(dealId, toType, toId, typeId){
    if (!dealId || !toId) return;
    try { await fastn.connector.hubspot.createAssociation({ fromObjectType:"deals", fromObjectId:String(dealId), toObjectType:toType, toObjectId:String(toId), types: JSON.stringify([{associationCategory:"HUBSPOT_DEFINED", associationTypeId:typeId}]) }); } catch(e){}
  }

  let _ownersByName = null;
  async function ownerIdByName(name){
    if (!name) return null;
    if (!_ownersByName){
      _ownersByName = {};
      try {
        const ow = await fastn.connector.hubspot.listOwners({ limit: 100 });
        for (const o of (ow.output?.results || [])){
          const nm = [o.firstName, o.lastName].filter(Boolean).join(" ").trim();
          if (nm) _ownersByName[nm.toLowerCase()] = o.id;
          if (o.email) _ownersByName[String(o.email).toLowerCase()] = o.id;
        }
      } catch(e){}
    }
    return _ownersByName[String(name).trim().toLowerCase()] || null;
  }

  const _custContacts = {};
  async function resolveCin7ContactId(summary, d){
    const direct = d.ContactID || (d.Contact && d.Contact.ID) || (Array.isArray(d.Contacts) ? (d.Contacts.find(c=>c.Default)||d.Contacts[0])?.ID : null);
    if (direct) return direct;
    const custId = summary.CustomerID || d.CustomerID;
    if (!custId) return null;
    if (!(custId in _custContacts)){
      try { const c = await fastn.connector.cin7core.listCustomers({ ID: String(custId), Limit: 1 }); _custContacts[custId] = c.output?.CustomerList?.[0]?.Contacts || []; }
      catch(e){ _custContacts[custId] = []; }
    }
    const contacts = _custContacts[custId];
    if (!contacts.length) return null;
    const norm = (s)=>String(s||"").trim().toLowerCase();
    const wantName = norm(typeof d.Contact === "string" ? d.Contact : d.Contact?.Name);
    const wantEmail = norm(d.Email);
    const hit = (wantName && contacts.find(c=>norm(c.Name)===wantName)) || (wantEmail && contacts.find(c=>norm(c.Email)===wantEmail)) || contacts.find(c=>c.Default) || contacts[0];
    return hit?.ID || null;
  }

  const result = { created:0, updated:0, skipped:0, errors:0, errorDetails:[], skippedDetails:[], details:[] };
  const note = (s, action, reason) => { const e = { sourceId: s&&(s.SaleID??null), orderNumber: s&&(s.OrderNumber??null), customer: s&&(s.Customer??null), action, reason: reason||null }; result.details.push(e); try { console.log("[sale "+(e.orderNumber||e.sourceId)+"] "+action+(reason?(" — "+reason):"")); } catch(_){} };
  const skip = (s, reason, extra) => {
    result.skipped++;
    const entry = { sourceId: s?.SaleID ?? null, orderNumber: s?.OrderNumber ?? null, customer: s?.Customer ?? null, reason, ...(extra || {}) };
    result.skippedDetails.push(entry); result.details.push({ sourceId: entry.sourceId, orderNumber: entry.orderNumber, customer: entry.customer, action: "skipped", reason: entry.reason });
    console.log(`[SKIP] sale ${entry.orderNumber || entry.sourceId}${entry.customer ? ` (${entry.customer})` : ""} — ${reason}`);
  };

  const sanitizeProp=(n)=>{ let s=String(n||"").trim().toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"").replace(/_+/g,"_"); if(!s) s="custom_property"; if(!/^[a-z]/.test(s)) s="p_"+s; return s; };
  // Ensure custom props exist: read existing ones first, only create what's missing
  // (an already-existing property is normal — never fire a createProperty that 409s).
  {
    const existingProps=new Set();
    try{ const lp=await fastn.connector.hubspot.listProperties({objectType:"deals"}); const arr=(lp&&lp.output&&(Array.isArray(lp.output)?lp.output:lp.output.results))||[]; for(const p of arr){ if(p&&p.name) existingProps.add(String(p.name)); } }catch(e){}
    for (const cf of (dir.customFields || [])){ const raw = cf.customPropertyName || cf.targetField; if (!raw) continue; const nm = sanitizeProp(raw); if(existingProps.has(nm)) continue; try { await fastn.connector.hubspot.createProperty({ objectType:"deals", name: nm, label: raw, type: cf.type || "string", fieldType: "text", groupName: "dealinformation" }); } catch(e){} }
  }
  const cursor = isManual ? (input.modifiedSince || null) : (await fastn.state.get(CURSOR_KEY) || null);
  let newCursorMax = cursor;
  let page = 1;

  while (page <= maxPages){
    const params = { Limit: limit, Page: page };
    if (cursor) params.ModifiedSince = cursor;
    let resp;
    try { resp = await fastn.connector.cin7core.listSales(params); }
    catch(e){ result.errors++; result.errorDetails.push({ page, reason:"listSales failed", errorMessage:String(e).slice(0,200) }); break; }
    const sales = resp.output?.SaleList || [];
    if (sales.length === 0) break;

    for (const summary of sales){
      try {
        if (summary.Updated && (!newCursorMax || new Date(summary.Updated) > new Date(newCursorMax))) newCursorMax = summary.Updated;
        if (!eligible(summary.SaleID)) { skip(summary, "excluded by the sync eligibility list in the config"); continue; }
        if (String(summary.Status || "").toUpperCase() === "VOIDED") {
          let voidDealId = null;
          try { const ds = await fastn.connector.hubspot.searchDeals({ filterGroups:[{filters:[{propertyName:"cin7_sale_id",operator:"EQ",value:String(summary.SaleID)}]}], sorts:[], query:"", properties:["cin7_sale_id"], limit:1, after:"0" }); voidDealId = ds?.output?.results?.[0]?.id || null; } catch(e){}
          if (!voidDealId) voidDealId = await fastn.state.get(IDMAP(summary.SaleID));
          if (voidDealId) {
            const voidStage = mapStage("VOIDED");
            try { await fastn.connector.hubspot.updateDeal({ dealId: String(voidDealId), properties: { dealstage: voidStage } }); result.updated++; note(summary, "updated", "VOIDED sale — deal moved to mapped void stage"); }
            catch(e){
              const em = String(e);
              if (/resource not found|404|does not exist/i.test(em)) {
                // The mapped HubSpot deal was deleted — stale idmap. Self-heal: clear it and skip (not an error).
                try { await fastn.state.delete(IDMAP(summary.SaleID)); } catch(_){}
                try { await fastn.state.delete(HASH(summary.SaleID)); } catch(_){}
                skip(summary, "sale is VOIDED but its mapped HubSpot deal no longer exists — cleared stale mapping");
              } else {
                result.errors++; result.errorDetails.push({ sourceId: summary.SaleID, reason: "void stage update failed", errorMessage: em.slice(0,150) });
              }
            }
          } else { skip(summary, "sale is VOIDED and no matching HubSpot deal exists to move — nothing to sync"); }
          continue;
        }
        const condFail = evalConditions(summary);
        if (condFail) { skip(summary, "config filter not met: " + condFail); continue; }

        let d = {};
        try { const det = await fastn.connector.cin7core.getSale({ ID: summary.SaleID }); d = det.output || {}; }
        catch(e){ result.errors++; note(summary, "error", "getSale failed: "+String(e).slice(0,120)); result.errorDetails.push({ sourceId: summary.SaleID, reason:"getSale failed", errorMessage:String(e).slice(0,200) }); continue; }

        const rec = { ...summary, ...d, SaleID: summary.SaleID, InvoiceAmount: (d.Quote?.Total ?? d.Order?.Total), Customer: d.SalesRepresentative };
        const props = {};
        for (const m of mappings){ const v = (typeof m.sourceField === "string" && m.sourceField.startsWith("__fixed:")) ? m.sourceField.slice(8) : rec[m.sourceField]; if (v !== undefined && v !== null) props[m.targetField] = v; }
        for (const cf of (dir.customFields || [])){ const rawT = cf.customPropertyName || cf.targetField; if (!rawT || cf.sourceField == null || cf.sourceField === "") continue; const tgt = sanitizeProp(rawT); if (props[tgt] !== undefined) continue; const v = (typeof cf.sourceField === "string" && cf.sourceField.startsWith("__fixed:")) ? cf.sourceField.slice(8) : rec[cf.sourceField]; if (v !== undefined && v !== null && v !== "") props[tgt] = v; }

        const contactOrCustomer = d.Contact || summary.Customer;
        const orderNum = d.Order?.SaleOrderNumber || summary.OrderNumber;
        props.dealname = contactOrCustomer ? `${contactOrCustomer} - ${orderNum}` : orderNum;
        const amount = (d.Quote?.Total ?? 0) || (d.Order?.Total ?? 0);
        props.amount = amount;
        props.dealstage = mapStage(summary.Status);
        props.pipeline = "default";
        if (summary.Status === "ORDERED") props.closedate = new Date().toISOString();
        let ownerId = await ownerIdByName(d.SalesRepresentative);
        if (!ownerId){ const defOwner = (config.cin7Defaults && config.cin7Defaults.defaultOwnerEmail) || null; if (defOwner) ownerId = await ownerIdByName(defOwner); }
        if (ownerId) props.hubspot_owner_id = String(ownerId);

        if (!props.dealstage || !props.dealname) { skip(summary, !props.dealname ? "cannot build a deal name — sale has no contact/customer and no order number" : ("no HubSpot deal stage mapped for Cin7 status '" + summary.Status + "'")); continue; }

        let gCompany = null;
        try { const cs = await fastn.connector.hubspot.searchCompanies({ filterGroups:[{filters:[{propertyName:"cin7_external_company_id",operator:"EQ",value:String(summary.CustomerID)}]}], sorts:[], query:"", properties:["cin7_external_company_id"], limit:1, after:"0" }); gCompany = cs?.output?.results?.[0]?.id || null; } catch(e){}
        if (!gCompany){ const _sid=await fastn.state.get(CUST_IDMAP(summary.CustomerID)); if(_sid){ try{ const _gc=await fastn.connector.hubspot.getCompany({companyId:String(_sid)}); if(_gc?.output?.id && _gc.output.archived!==true) gCompany=String(_sid); }catch(_ge){} } }
        const gCin7ContactId = await resolveCin7ContactId(summary, d);
        let gContact = null;
        if (gCin7ContactId){ try { const s = await fastn.connector.hubspot.searchContacts({ filterGroups:[{filters:[{propertyName:"cin7_external_id",operator:"EQ",value:String(gCin7ContactId)}]}], sorts:[], query:"", properties:["cin7_external_id"], limit:1, after:"0" }); gContact = s?.output?.results?.[0]?.id || null; } catch(e){} if (!gContact){ const _sid=await fastn.state.get(CONTACT_IDMAP(gCin7ContactId)); if(_sid){ try{ const _gc=await fastn.connector.hubspot.getContact({contactId:String(_sid)}); if(_gc?.output?.id && _gc.output.archived!==true) gContact=String(_sid); }catch(_ge){} } } }
        let gLine = false; let _depsChanged=false;
        for (const ln of (d.Order?.Lines || [])){ if ((ln.SKU==null||String(ln.SKU).trim()==="") && (ln.Name==null||String(ln.Name).trim()==="")) continue; if (ln.SKU){ try { const sp = await fastn.connector.hubspot.searchProducts({ filterGroups:[{filters:[{propertyName:"hs_sku",operator:"EQ",value:String(ln.SKU)}]}], sorts:[], query:"", properties:["hs_sku"], limit:1, after:"0" }); if (sp?.output?.results?.[0]?.id){ gLine = true; break; } } catch(e){} } }
        if(!gCompany){ try{ await fastn.flow.invoke("c7hs-evt-customer-cin7-to-hubspot", { customerId: String(summary.CustomerID) }); _depsChanged=true; }catch(_ae){ try{ console.log("[sale "+(summary.OrderNumber||summary.SaleID)+"] dep company create failed: "+String(_ae).slice(0,150)); }catch(_be){} } try{ gCompany=(await fastn.state.get(CUST_IDMAP(summary.CustomerID)))||gCompany; }catch(_se){} if(!gCompany){ try{ const _cs=await fastn.connector.hubspot.searchCompanies({filterGroups:[{filters:[{propertyName:"cin7_external_company_id",operator:"EQ",value:String(summary.CustomerID)}]}],sorts:[],query:"",properties:["cin7_external_company_id"],limit:1,after:"0"}); gCompany=_cs?.output?.results?.[0]?.id||gCompany; }catch(_ce){} } }
        if(!gContact && gCin7ContactId){ try{ await fastn.flow.invoke("c7hs-evt-contact-cin7-to-hubspot", { customerId: String(summary.CustomerID) }); _depsChanged=true; }catch(_ae){ try{ console.log("[sale "+(summary.OrderNumber||summary.SaleID)+"] dep contact create failed: "+String(_ae).slice(0,150)); }catch(_be){} } try{ gContact=(await fastn.state.get(CONTACT_IDMAP(gCin7ContactId)))||gContact; }catch(_se){} if(!gContact){ try{ const _s2=await fastn.connector.hubspot.searchContacts({filterGroups:[{filters:[{propertyName:"cin7_external_id",operator:"EQ",value:String(gCin7ContactId)}]}],sorts:[],query:"",properties:["cin7_external_id"],limit:1,after:"0"}); gContact=_s2?.output?.results?.[0]?.id||gContact; }catch(_ce){} } }
        { const _pl=(d.Order?.Lines||[]).filter(ln=>ln.SKU && String(ln.SKU).trim()!==""); const _missSkus=[]; for(const _ln of _pl){ let _f=false; try{ const _sp=await fastn.connector.hubspot.searchProducts({filterGroups:[{filters:[{propertyName:"hs_sku",operator:"EQ",value:String(_ln.SKU)}]}],sorts:[],query:"",properties:["hs_sku"],limit:1,after:"0"}); if(_sp?.output?.results?.[0]?.id) _f=true; }catch(_ce){} if(_f){ gLine=true; } else { _missSkus.push(String(_ln.SKU)); } } if(_missSkus.length){ try{ await fastn.flow.invoke("c7hs-evt-product-cin7-to-hubspot", { skus:[...new Set(_missSkus)] }); _depsChanged=true; }catch(_ae){ try{ console.log("[sale "+(summary.OrderNumber||summary.SaleID)+"] dep product create failed: "+String(_ae).slice(0,150)); }catch(_be){} } for(const _ln2 of _pl){ if(gLine) break; try{ let _rid=null; if(_ln2.ProductID){ _rid=await fastn.state.get("c7hs:idmap:product:c2h:"+String(_ln2.ProductID)); } if(!_rid){ const _sp2=await fastn.connector.hubspot.searchProducts({filterGroups:[{filters:[{propertyName:"hs_sku",operator:"EQ",value:String(_ln2.SKU)}]}],sorts:[],query:"",properties:["hs_sku"],limit:1,after:"0"}); _rid=_sp2?.output?.results?.[0]?.id||null; } if(_rid) gLine=true; }catch(_ce){} } } }
        if (!gContact) { try { console.log("[sale "+(summary.OrderNumber||summary.SaleID)+"] contact not synced in HubSpot — proceeding with company-only association"); } catch(_e){} }
        if (!gCompany || !gLine){ skip(summary, "not yet syncable — missing in HubSpot: " + [!gCompany?("company (Cin7 customer '"+(summary.Customer||summary.CustomerID)+"' has no synced HubSpot company)"):null,!gLine?"line-item product (no sale line SKU matches a HubSpot product)":null].filter(Boolean).join("; ")); continue; }
        Object.keys(props).forEach(k => { if (props[k]==null) delete props[k]; });

        const hashVal = JSON.stringify(props);
        const priorHash = await fastn.state.get(HASH(summary.SaleID));
        let dealId = await fastn.state.get(IDMAP(summary.SaleID)); if(dealId){ try{ const _gd=await fastn.connector.hubspot.getDeal({dealId:String(dealId)}); if(!(_gd?.output?.id) || _gd.output.archived===true) dealId=null; }catch(_ge){ dealId=null; } }
        if(!dealId){ try{ const sc=await fastn.connector.hubspot.searchDeals({filterGroups:[{filters:[{propertyName:"cin7_sale_id",operator:"EQ",value:String(summary.SaleID)}]}],sorts:[],query:"",properties:["cin7_sale_id"],limit:1,after:"0"}); dealId=sc?.output?.results?.[0]?.id||null; }catch(e){} }
        if(!dealId && props.dealname){ try{ const dn=await fastn.connector.hubspot.searchDeals({filterGroups:[{filters:[{propertyName:"dealname",operator:"EQ",value:String(props.dealname)}]}],sorts:[],query:"",properties:["dealname"],limit:1,after:"0"}); dealId=dn?.output?.results?.[0]?.id||null; }catch(e){} }
        if (dealId && priorHash === hashVal && !_depsChanged) { skip(summary, "already synced and unchanged since the last sync (nothing to update)", { dealId: String(dealId) }); continue; }

        let isNew = false;
        if (dealId){
          try { await fastn.connector.hubspot.updateDeal({ dealId, properties: props }); result.updated++; note(summary, "updated", "existing HubSpot deal updated"); }
          catch(e){
            const s = await fastn.connector.hubspot.searchDeals({ filterGroups:[{filters:[{propertyName:"cin7_sale_id",operator:"EQ",value:String(summary.SaleID)}]}], sorts:[], query:"", properties:["cin7_sale_id"], limit:1, after:"0" }).catch(()=>null);
            const found = s?.output?.results?.[0]?.id;
            if (found){ await fastn.connector.hubspot.updateDeal({ dealId: found, properties: props }); dealId = found; result.updated++; note(summary, "updated", "matched existing deal by cin7_sale_id (self-heal)"); }
            else { const c = await fastn.connector.hubspot.createDeal({ properties: props }); dealId = c.output?.id; isNew = true; result.created++; note(summary, "created", "new HubSpot deal created"); }
          }
        } else {
          const s = await fastn.connector.hubspot.searchDeals({ filterGroups:[{filters:[{propertyName:"cin7_sale_id",operator:"EQ",value:String(summary.SaleID)}]}], sorts:[], query:"", properties:["cin7_sale_id"], limit:1, after:"0" }).catch(()=>null);
          const found = s?.output?.results?.[0]?.id;
          if (found){ await fastn.connector.hubspot.updateDeal({ dealId: found, properties: props }); dealId = found; result.updated++; note(summary, "updated", "matched existing deal by cin7_sale_id (self-heal)"); }
          else { const c = await fastn.connector.hubspot.createDeal({ properties: props }); dealId = c.output?.id; isNew = true; result.created++; note(summary, "created", "new HubSpot deal created"); }
        }

        if (dealId){
          let companyId = null;
          if (summary.CustomerID){
            try {
              const cs = await fastn.connector.hubspot.searchCompanies({ filterGroups:[{filters:[{propertyName:"cin7_external_company_id",operator:"EQ",value:String(summary.CustomerID)}]}], sorts:[], query:"", properties:["cin7_external_company_id"], limit:1, after:"0" });
              companyId = cs?.output?.results?.[0]?.id || null;
            } catch(e){}
            if (!companyId) companyId = await fastn.state.get(CUST_IDMAP(summary.CustomerID));
          }
          if (companyId) await assoc(dealId, "companies", companyId, 5);

          const cin7ContactId = await resolveCin7ContactId(summary, d);
          let hsContactId = null;
          if (cin7ContactId){
            try {
              const ct = await fastn.connector.hubspot.searchContacts({ filterGroups:[{filters:[{propertyName:"cin7_external_id",operator:"EQ",value:String(cin7ContactId)}]}], sorts:[], query:"", properties:["cin7_external_id"], limit:1, after:"0" });
              hsContactId = ct?.output?.results?.[0]?.id || null;
            } catch(e){}
            if (!hsContactId) hsContactId = await fastn.state.get(CONTACT_IDMAP(cin7ContactId));
          }
          if (hsContactId) await assoc(dealId, "contacts", hsContactId, 3);

          const saleLineCount = (d.Order?.Lines || []).length;
          let needLines = isNew;
          if (!isNew && saleLineCount){
            try { const ex = await fastn.connector.hubspot.listAssociations({ fromObjectType:"deals", fromObjectId:String(dealId), toObjectType:"line_items", limit:100 }); const _lids = (ex.output?.results||[]).map(r=>r.toObjectId).filter(Boolean); const _byKey = {}; for (const _lid of _lids){ try { const _g = await fastn.connector.hubspot.getLineItem({ lineItemId:String(_lid), properties:"hs_sku,name,quantity,price" }); const _p=(_g.output&&_g.output.properties)||{}; const _k=String(_p.hs_sku||_p.name||"").trim().toLowerCase(); if(_k) _byKey[_k]={ id:String(_lid), quantity:Number(_p.quantity), price:Number(_p.price) }; } catch(_e){} } for (const _ln of (d.Order?.Lines||[])){ const _k=String(_ln.SKU||_ln.Name||"").trim().toLowerCase(); const _cur=_byKey[_k]; if(_cur){ const _q=Number(_ln.Quantity), _pr=Number(_ln.Price); const _up={}; if(!Number.isNaN(_q)&&_q!==_cur.quantity) _up.quantity=_q; if(!Number.isNaN(_pr)&&_pr!==_cur.price) _up.price=_pr; if(Object.keys(_up).length){ try{ await fastn.connector.hubspot.updateLineItem({ lineItemId:_cur.id, properties:_up }); } catch(_e2){} } } } const have = _lids.length; needLines = have < saleLineCount; } catch(e){ needLines = false; }
          }
          if (needLines){
            const lines = d.Order?.Lines || [];
            for (const ln of lines){
              try {
                if ((ln.SKU == null || String(ln.SKU).trim() === "") && (ln.Name == null || String(ln.Name).trim() === "")) { continue; }
                let hsProductId = null;
                if (ln.SKU){
                  const sp = await fastn.connector.hubspot.searchProducts({ filterGroups:[{filters:[{propertyName:"hs_sku",operator:"EQ",value:String(ln.SKU)}]}], sorts:[], query:"", properties:["hs_sku"], limit:1, after:"0" }).catch(()=>null);
                  hsProductId = sp?.output?.results?.[0]?.id || null;
                  if(!hsProductId && ln.ProductID){ try{ hsProductId = (await fastn.state.get("c7hs:idmap:product:c2h:"+String(ln.ProductID))) || null; }catch(_pe){} }
                }
                const liProps = { name: ln.Name || ln.SKU || "Line item", price: ln.Price, quantity: ln.Quantity };
                if (hsProductId) liProps.hs_product_id = hsProductId;
                Object.keys(liProps).forEach(k=>{ if(liProps[k]==null) delete liProps[k]; });
                const li = await fastn.connector.hubspot.createLineItem({ properties: liProps });
                const liId = li.output?.id;
                if (liId) await assoc(dealId, "line_items", liId, 19);
              } catch(e){ /* line item failure is non-fatal */ }
            }
          }

          await fastn.state.set(IDMAP(summary.SaleID), String(dealId));
          await fastn.state.set(HASH(summary.SaleID), hashVal);
        }
      } catch(e){ result.errors++; note(summary, "error", "sync failed: "+String(e).slice(0,120)); result.errorDetails.push({ sourceId: summary.SaleID, reason:"sync failed", errorMessage:String(e).slice(0,200) }); }
    }
    if (sales.length < limit) break;
    page++;
  }
  if (!isManual && newCursorMax) await fastn.state.set(CURSOR_KEY, newCursorMax);
  return result;
}