export default async function (ctx) {
  const TEMPLATE_ID = "cfg_0a958721d430"; // getByTemplate resolves the installation's clone
  const SOURCE_ENTITY = "customer", SOURCE_CONN = "cin7core";
  const TARGET_ENTITY = "company", TARGET_CONN = "hubspot";
  const CURSOR_KEY = "c7hs:cursor:customer:cin7-to-hubspot";
  const IDMAP = (id) => `c7hs:idmap:customer:c2h:${id}`;
  const HASH = (id) => `c7hs:hash:customer:c2h:${id}`;

  // Ambient `fastn` global — connector calls route to the installation's connections.
  const input = ctx.input || {};
  const directIds = (input.customerId != null ? [String(input.customerId)] : [])
    .concat(Array.isArray(input.customerIds) ? input.customerIds.map(String) : []);
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

  const dir = flows.find(d =>
    (d.source?.entity ?? d.sourceEntity) === SOURCE_ENTITY && (d.source?.connector ?? d.sourceConnector) === SOURCE_CONN &&
    (d.target?.entity ?? d.targetEntity) === TARGET_ENTITY && (d.target?.connector ?? d.targetConnector) === TARGET_CONN);
  if (!dir) return { error: "customer entity not found in config", created:0, updated:0, skipped:0, linked:0, errors:0, errorDetails:[] };
  // Outbound (Cin7 -> HubSpot): use 'both' + 'outbound' as-is; skip 'inbound'-only fixed values.
  const mappings = (dir.mappings || []).filter(m => (m.syncDirection || "both") !== "inbound");
  const conditions = dir.conditions || [];

  const elig = (config.eligibility && config.eligibility.customer) || {};
  const included = Array.isArray(elig.included) ? elig.included : [];
  const excluded = Array.isArray(elig.excluded) ? elig.excluded : [];
  function eligible(id){ if (included.length && !included.includes(id)) return false; if (excluded.length && excluded.includes(id)) return false; return true; }

  function normAddrType(t){ const s=String(t||"").toLowerCase(); if(s==="shipment"||s==="shipping")return "Shipping"; if(s==="billing")return "Billing"; if(s==="business")return "Business"; return t; }
  const ADDRESS_TYPE = (conditions.find(c => c.field === "addressType") || {}).value || null;
  function defaultAddress(rec){
    const a = rec.Addresses||[];
    const want = (typeof ADDRESS_TYPE === "string" && ADDRESS_TYPE) ? normAddrType(ADDRESS_TYPE) : null;
    if (want) { const ofType = a.filter(x=>String(x.Type)===want); const pick = ofType.find(x=>x.DefaultForType) || ofType[0]; if (pick) return pick; }
    return a.find(x=>x.DefaultForType) || a[0] || {};
  }
  function defaultContact(rec){ const c = rec.Contacts||[]; return c.find(x=>x.Default) || c[0] || {}; }
  function getPath(obj, path){
    if (path == null) return undefined;
    if (String(path).startsWith("__fixed:")) return String(path).slice(8);
    const parts = String(path).split(".");
    if (parts[0] === "Addresses") return defaultAddress(obj)[parts[1]];
    if (parts[0] === "Contacts") return defaultContact(obj)[parts[1]];
    return parts.reduce((o,k)=>(o==null?undefined:o[k]), obj);
  }
  function evalConditions(rec){
    for (const c of conditions){
      if (c.field === "addressType") continue;
      const v = getPath(rec, c.field); const op = c.operator; const target = c.value;
      const pass = op==="equals"?String(v)===String(target):op==="not_equals"?String(v)!==String(target)
        :op==="contains"?String(v??"").includes(target):op==="is_empty"?!v:op==="is_not_empty"?!!v
        :op==="in"?String(target).split(",").map(s=>s.trim()).includes(String(v)):op==="not_in"?!String(target).split(",").map(s=>s.trim()).includes(String(v)):true;
      if (!pass) return false;
    }
    return true;
  }
  const customFields = dir.customFields || [];
  const sanitizeProp=(n)=>{ let s=String(n||"").trim().toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"").replace(/_+/g,"_"); if(!s) s="custom_property"; if(!/^[a-z]/.test(s)) s="p_"+s; return s; };
  function buildProps(rec){
    const props = {};
    for (const m of mappings){ let val = getPath(rec, m.sourceField); if (val === undefined) continue; props[m.targetField] = val; }
    for (const cf of customFields){
      const rawT = cf.customPropertyName || cf.targetField;
      if (!rawT || cf.sourceField == null || cf.sourceField === "") continue;
      const target = sanitizeProp(rawT);
      if (props[target] !== undefined) continue;
      const val = getPath(rec, cf.sourceField); if (val === undefined) continue;
      props[target] = val;
    }
    return props;
  }
  const nameMapping = mappings.find(m => m.targetField === "name");
  const NAME_FIELD = nameMapping ? "name" : "name";

  const result = { created:0, updated:0, skipped:0, linked:0, errors:0, errorDetails:[], details:[] };
  const note = (cu, action, reason) => { const e = { customerId: cu && (cu.ID!=null?String(cu.ID):null), name: (cu && cu.Name) || null, contactCount: (cu && Array.isArray(cu.Contacts)) ? cu.Contacts.length : 0, contactEmails: (cu && Array.isArray(cu.Contacts)) ? cu.Contacts.map(x=>x&&x.Email).filter(Boolean) : [], action, reason: reason||null }; result.details.push(e); try { console.log("[customer "+e.customerId+" \""+(e.name||"")+"\"] "+action+(reason?(" — "+reason):"")); } catch(_){} };

  // Ensure custom props exist: read existing ones first, only create what's missing
  // (an already-existing property is normal — never fire a createProperty that 409s).
  {
    const existingProps=new Set();
    try{ const lp=await fastn.connector.hubspot.listProperties({objectType:"companies"}); const arr=(lp&&lp.output&&(Array.isArray(lp.output)?lp.output:lp.output.results))||[]; for(const p of arr){ if(p&&p.name) existingProps.add(String(p.name)); } }catch(e){}
    for (const cf of customFields){ const nm = cf.customPropertyName || cf.targetField; if (!nm) continue; if(existingProps.has(sanitizeProp(nm))) continue; try { await fastn.connector.hubspot.createProperty({ objectType:"companies", name: sanitizeProp(nm), label: nm, type: cf.type || "string", fieldType: "text", groupName: "companyinformation" }); } catch(e){} }
  }

  async function searchByCin7Id(cid){
    try {
      const s = await fastn.connector.hubspot.searchCompanies({ filterGroups:[{filters:[{propertyName:"cin7_external_company_id",operator:"EQ",value:String(cid)}]}], sorts:[], query:"", properties:["cin7_external_company_id"], limit:1, after:"0" });
      return s?.output?.results?.[0]?.id || null;
    } catch(e){ return null; }
  }
  async function searchByName(name){
    if (!name) return null;
    try {
      const s = await fastn.connector.hubspot.searchCompanies({ filterGroups:[{filters:[{propertyName:"name",operator:"EQ",value:String(name)}]}], sorts:[], query:"", properties:["name","cin7_external_company_id"], limit:5, after:"0" });
      const results = s?.output?.results || [];
      const unlinked = results.find(r => !r.properties?.cin7_external_company_id);
      return (unlinked || results[0])?.id || null;
    } catch(e){ return null; }
  }

  // COMPANY + CONTACTS TOGETHER: sync a customer's nested Contacts[] to HubSpot
  // (create/update + associate to the company) via the self-contained per-customer
  // contact handler, invoked synchronously. Dedupes internally, so cheap on re-runs.
  async function syncContactsInline(cu, targetId){
    if (!(targetId && Array.isArray(cu.Contacts) && cu.Contacts.length)) return;
    try {
      const _cEnt = (config.entities||[]).find(e=>e&&e.source&&e.source.entity==="contact"&&e.source.connector==="cin7core");
      const _cMaps = (_cEnt&&_cEnt.mappings)||[];
      const _nameSplit = _cMaps.find(m=>m&&m.mappingMode==="split"&&m.targetField==="firstname");
      const _splitSep = (_nameSplit&&_nameSplit.splitSeparator) || " ";
      const _split = (full)=>{ const s=(_splitSep&&String(_splitSep).trim()!=="")?String(_splitSep):/\s+/; const p=String(full||"").trim().split(s).filter(Boolean); return { first:p.shift()||"", last:p.join(" ") }; };
      for (const ct of cu.Contacts){
        try {
          const email = ct.Email && String(ct.Email).trim();
          const nm = ct.Name && String(ct.Name).trim();
          if (!email || !nm){ result.contactsSkipped = (result.contactsSkipped||0)+1; continue; }
          const sn = _split(nm);
          const props = { firstname: sn.first, lastname: sn.last, email: email, cin7_external_id: String(ct.ID), cin7_parent_customer_id: String(cu.ID) };
          if (ct.Phone) props.phone = String(ct.Phone);
          if (ct.JobTitle) props.jobtitle = String(ct.JobTitle);
          const IK = "c7hs:idmap:contact:c2h:"+ct.ID;
          let hsId = await fastn.state.get(IK);
          if (!hsId){ try { const s1 = await fastn.connector.hubspot.searchContacts({ filterGroups:[{filters:[{propertyName:"cin7_external_id",operator:"EQ",value:String(ct.ID)}]}], sorts:[], query:"", after:"0", properties:["email"], limit:1 }); hsId = (s1.output&&s1.output.results&&s1.output.results[0]&&s1.output.results[0].id)||null; } catch(_e){} }
          if (!hsId){ try { const s2 = await fastn.connector.hubspot.searchContacts({ filterGroups:[{filters:[{propertyName:"email",operator:"EQ",value:email}]}], sorts:[], query:"", after:"0", properties:["email"], limit:1 }); hsId = (s2.output&&s2.output.results&&s2.output.results[0]&&s2.output.results[0].id)||null; } catch(_e){} }
          if (hsId){
            try { await fastn.connector.hubspot.updateContact({ contactId:String(hsId), properties:props }); result.contactsUpdated = (result.contactsUpdated||0)+1; }
            catch(ue){
              if (/resource not found|does not exist|404/i.test(String(ue))) {
                // stale idmap — the HubSpot contact was deleted. Self-heal: clear and recreate.
                try { await fastn.state.delete(IK); } catch(_e){}
                hsId = null;
              } else { throw ue; }
            }
          }
          if (!hsId){ let c; try { c = await fastn.connector.hubspot.createContact({ properties:props }); } catch(ce){ c = await fastn.connector.hubspot.createContact({ properties:{ firstname:sn.first, lastname:sn.last, email:email } }); } hsId = c.output&&c.output.id; result.contactsCreated = (result.contactsCreated||0)+1; }
          if (hsId){ await fastn.state.set(IK, String(hsId)); try { await fastn.connector.hubspot.createDefaultAssociation({ fromObjectType:"contact", fromObjectId:String(hsId), toObjectType:"company", toObjectId:String(targetId) }); } catch(_e){} }
        } catch(e){ result.contactErrors = (result.contactErrors||0)+1; result.errorDetails.push({ custId: cu.ID, contactEmail: (ct&&ct.Email)||null, reason: "inline contact create/update failed", errorMessage: String(e).slice(0,140) }); }
      }
    } catch(e){ result.contactErrors = (result.contactErrors||0) + 1; result.errorDetails.push({ custId: cu.ID, reason: "inline contact sync failed", errorMessage: String(e).slice(0,150) }); }
  }

  async function syncCustomer(cu){
    const _origin = await fastn.state.get("c7hs:custorigin:"+String(cu.ID)); if(_origin==="hs-contact"){ result.skipped++; note(cu, "skipped", "originated from a HubSpot contact sync (loop prevention)"); return; }
    if (!eligible(cu.ID)) { result.skipped++; note(cu, "skipped", "excluded by the config eligibility (include/exclude) list"); return; }
    if (!evalConditions(cu)) { result.skipped++; note(cu, "skipped", "config filter/condition not met (e.g. Status is not Active)"); return; }
    const props = buildProps(cu);
    const hashVal = JSON.stringify(props);
    const priorHash = await fastn.state.get(HASH(cu.ID));
    let targetId = await fastn.state.get(IDMAP(cu.ID));

    if (targetId && priorHash === hashVal) {
      let stillExists = false;
      const found = await searchByCin7Id(cu.ID);
      if (found) { stillExists = true; if (String(found) !== String(targetId)) targetId = found; }
      if (stillExists) { result.skipped++; note(cu, "skipped", "unchanged since last sync (hash match) — company already in HubSpot"); await syncContactsInline(cu, targetId); return; }
      await fastn.state.delete(IDMAP(cu.ID)).catch(()=>{});
      await fastn.state.delete(HASH(cu.ID)).catch(()=>{});
      targetId = null;
    }
    Object.keys(props).forEach(k => { if (props[k]==null) delete props[k]; });

    let linkedNow = false;
    if (!targetId){
      targetId = await searchByCin7Id(cu.ID);
      if (!targetId){
        const byName = await searchByName(props[NAME_FIELD] || cu.Name);
        if (byName){ targetId = byName; linkedNow = true; }
      }
    }

    if (targetId){
      if (props.cin7_external_company_id === undefined) props.cin7_external_company_id = String(cu.ID);
      try {
        await fastn.connector.hubspot.updateCompany({ companyId: targetId, properties: props });
        if (linkedNow) { result.linked++; note(cu, "linked", "existing HubSpot company re-linked to this customer"); } else { result.updated++; note(cu, "updated", "mapped fields changed — company updated"); }
      } catch(e){
        const found = await searchByCin7Id(cu.ID) || await searchByName(props[NAME_FIELD] || cu.Name);
        if (found){ await fastn.connector.hubspot.updateCompany({ companyId: found, properties: props }); targetId = found; result.updated++; note(cu, "updated", "matched existing company by name and updated (self-heal)"); }
        else { const c = await fastn.connector.hubspot.createCompany({ properties: props }); targetId = c.output?.id; result.created++; note(cu, "created", "new HubSpot company created"); }
      }
    } else {
      if (props.cin7_external_company_id === undefined) props.cin7_external_company_id = String(cu.ID);
      try { const c = await fastn.connector.hubspot.createCompany({ properties: props }); targetId = c.output?.id; result.created++; note(cu, "created", "new HubSpot company created"); }
      catch(e){
        const found = await searchByCin7Id(cu.ID) || await searchByName(props[NAME_FIELD] || cu.Name);
        if (found){ await fastn.connector.hubspot.updateCompany({ companyId: found, properties: props }); targetId = found; result.updated++; note(cu, "updated", "matched existing company by name and updated (self-heal)"); }
        else throw e;
      }
    }
    if (targetId){ await fastn.state.set(IDMAP(cu.ID), String(targetId)); await fastn.state.set(HASH(cu.ID), hashVal); }
    await syncContactsInline(cu, targetId);
  }

  if (isDirect){
    for (const id of directIds){
      try {
        const r = await fastn.connector.cin7core.listCustomers({ ID: String(id), Limit: 1 });
        const cu = r.output?.CustomerList?.[0];
        if (!cu) { result.skipped++; result.errorDetails.push({ sourceId:id, reason:"customer not found" }); continue; }
        await syncCustomer(cu);
      } catch(e){ result.errors++; note({ID:id}, "error", "direct sync failed: "+String(e).slice(0,120)); result.errorDetails.push({ sourceId:id, reason:"direct sync failed", errorMessage:String(e).slice(0,200) }); }
    }
    return { ...result, mode:"direct", customerIds: directIds };
  }

  // FULL-SCAN MODE: incremental ModifiedSince cursor removed by request — every run scans ALL
  // Cin7 customers. Unchanged records are still skipped by the hash dedupe (no HubSpot writes).
  // Pass input.modifiedSince explicitly to bound a manual run.
  const cursor = input.modifiedSince || null;
  let newCursorMax = cursor;
  let page = 1;
  while (page <= maxPages){
    const params = { Limit: limit, Page: page };
    if (cursor) params.ModifiedSince = cursor;
    let resp;
    try { resp = await fastn.connector.cin7core.listCustomers(params); }
    catch(e){ result.errors++; result.errorDetails.push({ page, reason:"listCustomers failed", errorMessage:String(e).slice(0,200) }); break; }
    const customers = resp.output?.CustomerList || [];
    if (customers.length === 0) break;
    for (const cu of customers){
      try {
        if (cu.LastModifiedOn && (!newCursorMax || new Date(cu.LastModifiedOn) > new Date(newCursorMax))) newCursorMax = cu.LastModifiedOn;
        await syncCustomer(cu);
      } catch(e){ result.errors++; note(cu, "error", "sync failed: "+String(e).slice(0,120)); result.errorDetails.push({ sourceId: cu.ID, reason:"sync failed", errorMessage:String(e).slice(0,200) }); }
    }
    if (customers.length < limit) break;
    page++;
  }
  // cursor no longer persisted — full scan every run
  return result;
}