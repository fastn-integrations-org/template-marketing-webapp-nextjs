export default async function (ctx) {
  const TEMPLATE_ID = "cfg_0a958721d430"; // getByTemplate resolves the installation's clone
  const SOURCE_ENTITY = "contact", SOURCE_CONN = "cin7core";
  const TARGET_ENTITY = "contact", TARGET_CONN = "hubspot";
  const CURSOR_KEY = "c7hs:cursor:contact:cin7-to-hubspot";
  const IDMAP = (contactId) => `c7hs:idmap:contact:c2h:${contactId}`;
  const HASH = (contactId) => `c7hs:hash:contact:c2h:${contactId}`;

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
  if (!dir) return { error: "contact entity not found in config", created:0, updated:0, skipped:0, errors:0, errorDetails:[] };
  // Outbound (Cin7 -> HubSpot): use 'both' + 'outbound' as-is; skip 'inbound'-only.
  const mappings = (dir.mappings || []).filter(m => (m.syncDirection || "both") !== "inbound");
  const conditions = dir.conditions || [];
  const customFields = dir.customFields || [];
  const sanitizeProp=(n)=>{ let s=String(n||"").trim().toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"").replace(/_+/g,"_"); if(!s) s="custom_property"; if(!/^[a-z]/.test(s)) s="p_"+s; return s; };

  const elig = (config.eligibility && config.eligibility.contact) || {};
  const included = Array.isArray(elig.included) ? elig.included : [];
  const excluded = Array.isArray(elig.excluded) ? elig.excluded : [];
  function eligible(id){ if (included.length && !included.includes(id)) return false; if (excluded.length && excluded.includes(id)) return false; return true; }

  function evalConditions(cu){
    for (const c of conditions){
      if (c.field === "addressType") continue;
      const v = cu[c.field]; const op = c.operator; const target = c.value;
      const pass = op==="equals"?String(v)===String(target):op==="not_equals"?String(v)!==String(target)
        :op==="contains"?String(v??"").includes(target):op==="is_empty"?!v:op==="is_not_empty"?!!v
        :op==="in"?String(target).split(",").map(s=>s.trim()).includes(String(v)):op==="not_in"?!String(target).split(",").map(s=>s.trim()).includes(String(v)):true;
      if (!pass) return false;
    }
    return true;
  }
  function splitName(full, sep){ const useSep = (sep!=null && String(sep).length && String(sep).trim()!=="") ? String(sep) : /\s+/; const parts = String(full||"").trim().split(useSep).filter(Boolean); const first = parts.shift() || ""; const last = parts.join(" "); return { first, last }; }

  const _companyByCust = {};
  async function companyIdForCustomer(custId){
    if (!custId) return null;
    if (custId in _companyByCust) return _companyByCust[custId];
    let id = null;
    try {
      const cs = await fastn.connector.hubspot.searchCompanies({ filterGroups:[{filters:[{propertyName:"cin7_external_company_id",operator:"EQ",value:String(custId)}]}], sorts:[], query:"", properties:["cin7_external_company_id"], limit:1, after:"0" });
      id = cs?.output?.results?.[0]?.id || null;
    } catch(e){}
    if (!id) id = await fastn.state.get(`c7hs:idmap:customer:c2h:${custId}`);
    _companyByCust[custId] = id || null;
    return _companyByCust[custId];
  }
  async function linkContactToCompany(contactHsId, companyHsId){
    if (!contactHsId || !companyHsId) return;
    try { await fastn.connector.hubspot.createDefaultAssociation({ fromObjectType:"contacts", fromObjectId:String(contactHsId), toObjectType:"companies", toObjectId:String(companyHsId) }); } catch(e){}
  }

  function buildProps(cu, ct){
    const props = {};
    for (const m of mappings){
      let v;
      if (typeof m.sourceField === "string" && m.sourceField.startsWith("__fixed:")) v = m.sourceField.slice(8);
      else if (m.targetField === "cin7_parent_customer_id") v = cu.ID;
      else if (m.sourceField === "ID") v = cu.ID;
      else if (m.sourceField.startsWith("Contacts.")) v = ct[m.sourceField.split(".")[1]];
      else v = cu[m.sourceField];
      if (v == null) continue;
      if (m.targetField === "firstname") v = splitName(v, m.splitSeparator).first;
      else if (m.targetField === "lastname") v = splitName(v, m.splitSeparator).last;
      props[m.targetField] = v;
    }
    for (const cf of customFields){
      const rawT = cf.customPropertyName || cf.targetField;
      if (!rawT || cf.sourceField == null || cf.sourceField === "") continue;
      const tgt = sanitizeProp(rawT);
      if (props[tgt] !== undefined) continue;
      let v = String(cf.sourceField).startsWith("__fixed:") ? String(cf.sourceField).slice(8) : (String(cf.sourceField).startsWith("Contacts.") ? ct[String(cf.sourceField).split(".")[1]] : (cf.sourceField === "ID" ? cu.ID : cu[cf.sourceField]));
      if (v == null) continue;
      props[tgt] = v;
    }
    return props;
  }

  const result = { created:0, updated:0, skipped:0, errors:0, errorDetails:[], details:[] };
  const note = (contactId, action, reason, extra) => { const e = Object.assign({ contactId: contactId!=null?String(contactId):null, action, reason: reason||null }, extra||{}); result.details.push(e); try { console.log("[contact "+e.contactId+"] "+action+(reason?(" — "+reason):"")); } catch(_){} };

  // Ensure custom props exist: read existing ones first, only create what's missing
  // (an already-existing property is normal — never fire a createProperty that 409s).
  const _existingProps=new Set();
  try{ const lp=await fastn.connector.hubspot.listProperties({objectType:"contacts"}); const arr=(lp&&lp.output&&(Array.isArray(lp.output)?lp.output:lp.output.results))||[]; for(const p of arr){ if(p&&p.name) _existingProps.add(String(p.name)); } }catch(e){}
  for (const cf of customFields){ const nm = cf.customPropertyName || cf.targetField; if (!nm) continue; if(_existingProps.has(sanitizeProp(nm))) continue; try { await fastn.connector.hubspot.createProperty({ objectType:"contacts", name: sanitizeProp(nm), label: nm, type: cf.type || "string", fieldType: "text", groupName: "contactinformation" }); } catch(e){} }

  const cursor = isManual ? (input.modifiedSince || null) : (await fastn.state.get(CURSOR_KEY) || null);
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
        if (!evalConditions(cu)) { continue; }
        const contacts = cu.Contacts || [];
        for (const ct of contacts){
          try {
            const contactId = ct.ID;
            if (!contactId) { result.skipped++; note(null, "skipped", "Cin7 contact has no ID"); continue; }
            if (!eligible(contactId)) { result.skipped++; continue; }

            const props = buildProps(cu, ct);
            if (!props.email || !(props.firstname || props.lastname)) { result.skipped++; note(contactId, "skipped", "contact missing required name or email"); continue; }
            Object.keys(props).forEach(k => { if (props[k]==null) delete props[k]; });

            const hashVal = JSON.stringify(props);
            const priorHash = await fastn.state.get(HASH(contactId));
            let hsId = await fastn.state.get(IDMAP(contactId));
            if (hsId && priorHash === hashVal) {
              let stillExists = false;
              try {
                const chk = await fastn.connector.hubspot.searchContacts({ filterGroups:[{filters:[{propertyName:"cin7_external_id",operator:"EQ",value:String(contactId)}]}], sorts:[], query:"", properties:["cin7_external_id"], limit:1, after:"0" });
                const f = chk?.output?.results?.[0]?.id;
                if (f) { stillExists = true; if (String(f) !== String(hsId)) hsId = f; }
              } catch(e) { stillExists = true; }
              if (stillExists) { result.skipped++; note(contactId, "skipped", "unchanged since last sync (hash match) — contact already in HubSpot"); continue; }
              await fastn.state.delete(IDMAP(contactId)).catch(()=>{});
              await fastn.state.delete(HASH(contactId)).catch(()=>{});
              hsId = null;
            }

            if (hsId){
              try { await fastn.connector.hubspot.updateContact({ contactId: hsId, properties: props }); result.updated++; note(contactId, "updated", "existing HubSpot contact updated"); }
              catch(e){
                const s = await fastn.connector.hubspot.searchContacts({ filterGroups:[{filters:[{propertyName:"cin7_external_id",operator:"EQ",value:String(contactId)}]}], sorts:[], query:"", properties:["cin7_external_id"], limit:1, after:"0" }).catch(()=>null);
                const found = s?.output?.results?.[0]?.id;
                if (found){ await fastn.connector.hubspot.updateContact({ contactId: found, properties: props }); hsId = found; result.updated++; note(contactId, "updated", "matched existing contact by Cin7 id (self-heal)"); }
                else { const c = await fastn.connector.hubspot.createContact({ properties: props }); hsId = c.output?.id; result.created++; note(contactId, "created", "new HubSpot contact created"); }
              }
            } else {
              const s = await fastn.connector.hubspot.searchContacts({ filterGroups:[{filters:[{propertyName:"cin7_external_id",operator:"EQ",value:String(contactId)}]}], sorts:[], query:"", properties:["cin7_external_id"], limit:1, after:"0" }).catch(()=>null);
              const found = s?.output?.results?.[0]?.id;
              if (found){ await fastn.connector.hubspot.updateContact({ contactId: found, properties: props }); hsId = found; result.updated++; note(contactId, "updated", "matched existing contact by Cin7 id (self-heal)"); }
              else {
                try { const c = await fastn.connector.hubspot.createContact({ properties: props }); hsId = c.output?.id; result.created++; note(contactId, "created", "new HubSpot contact created"); }
                catch(e){
                  if (props.email){
                    const se = await fastn.connector.hubspot.searchContacts({ filterGroups:[{filters:[{propertyName:"email",operator:"EQ",value:String(props.email)}]}], sorts:[], query:"", properties:["email"], limit:1, after:"0" }).catch(()=>null);
                    const fe = se?.output?.results?.[0]?.id;
                    if (fe){ await fastn.connector.hubspot.updateContact({ contactId: fe, properties: props }); hsId = fe; result.updated++; note(contactId, "updated", "matched existing contact by email (self-heal)"); }
                    else throw e;
                  } else throw e;
                }
              }
            }
            if (hsId){
              await fastn.state.set(IDMAP(contactId), String(hsId)); await fastn.state.set(HASH(contactId), hashVal);
              const companyHsId = await companyIdForCustomer(cu.ID);
              if (companyHsId) await linkContactToCompany(hsId, companyHsId);
            }
          } catch(e){ result.errors++; note(ct.ID, "error", "contact sync failed: "+String(e).slice(0,120)); result.errorDetails.push({ sourceId: ct.ID, customerId: cu.ID, reason:"contact sync failed", errorMessage:String(e).slice(0,200) }); }
        }
      } catch(e){ result.errors++; result.errorDetails.push({ sourceId: cu.ID, reason:"customer sync failed", errorMessage:String(e).slice(0,200) }); }
    }
    if (customers.length < limit) break;
    page++;
  }
  if (!isManual && newCursorMax) await fastn.state.set(CURSOR_KEY, newCursorMax);
  return result;
}