export default async function (ctx) {
  // Installation-aware: ambient fastn routes connectors through the installation's
  // connections; config resolves the per-installation clone from the widget template.
  const TEMPLATE_ID="cfg_0a958721d430";
  const IDMAP=(id)=>`c7hs:idmap:contact:c2h:${id}`;
  const HASH=(id)=>`c7hs:hash:contact:c2h:${id}`;

  const input=ctx.input||{}; const custIds=new Set();
  const add=(v)=>{ if(v!=null&&String(v).trim()!=="") custIds.add(String(v)); };
  if (input.customerId) add(input.customerId);
  if (Array.isArray(input.customerIds)) input.customerIds.forEach(add);
  const scan=(e)=>{ if(!e||typeof e!=="object") return; add(e.CustomerID); add(e.ID);
    for(const k of Object.keys(e)){ if(/DetailsList$/.test(k)&&Array.isArray(e[k])) e[k].forEach(x=>{ if(x){ add(x.ID); add(x.CustomerID); add(x.Customer&&x.Customer.ID); } }); } };
  if (Array.isArray(input)) input.forEach(scan); else scan(input);
  const result={created:0,updated:0,skipped:0,errors:0,details:[]};
  const ids=[...custIds];
  if(!ids.length) return {...result, reason:"no CustomerID in payload"};

  let cfg=(await fastn.config.getByTemplate(TEMPLATE_ID).catch(()=>null));
  const _hasEnt=(c)=>!!(c&&((Array.isArray(c.entities)&&c.entities.length)||(c.config&&Array.isArray(c.config.entities)&&c.config.entities.length)));
  if(!_hasEnt(cfg)) cfg=(await fastn.config.get(TEMPLATE_ID).catch(()=>null))||cfg||{};
  const flows=(cfg&&(cfg.entities||(cfg.config&&cfg.config.entities)))||[];
  const dir=flows.find(d=>d.source?.entity==="contact"&&d.source?.connector==="cin7core"&&d.target?.entity==="contact"&&d.target?.connector==="hubspot");
  if(!dir) return {...result, error:"contact direction not found"};
  // Outbound (Cin7 -> HubSpot) handler: exclude 'inbound' mappings (they target Cin7 fields).
  const mappings=(dir.mappings||[]).filter(m=>(m.syncDirection||"both")!=="inbound"); const conditions=dir.conditions||[]; const customFields=dir.customFields||[];

  // Sanitize a user-supplied custom property name into a valid HubSpot internal name.
  const sanitizeProp=(n)=>{ let s=String(n||"").trim().toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"").replace(/_+/g,"_"); if(!s) s="custom_property"; if(!/^[a-z]/.test(s)) s="p_"+s; return s; };

  // Ensure custom props exist: read existing ones first, only create what's missing
  // (an already-existing property is normal — never fire a createProperty that 409s).
  {
    const existingProps=new Set();
    try{ const lp=await fastn.connector.hubspot.listProperties({objectType:"contacts"}); const arr=(lp&&lp.output&&(Array.isArray(lp.output)?lp.output:lp.output.results))||[]; for(const p of arr){ if(p&&p.name) existingProps.add(String(p.name)); } }catch(e){}
    for (const cf of customFields){ const raw=cf.customPropertyName||cf.targetField; if(!raw) continue; const nm=sanitizeProp(raw); if(existingProps.has(nm)) continue; try{ await fastn.connector.hubspot.createProperty({objectType:"contacts",name:nm,label:raw,type:cf.type||"string",fieldType:"text",groupName:"contactinformation"}); }catch(e){} }
  }

  const splitName=(f,sep)=>{ const _sep=(sep!=null&&String(sep).trim()!=="")?String(sep):/\s+/; const p=String(f||"").trim().split(_sep).filter(Boolean); const first=p.shift()||""; return {first, last:p.join(" ")}; };
  const evalConditions=(cu)=>{ for(const c of conditions){ const v=cu[c.field]; const op=c.operator; const t=c.value; const pass= op==="equals"?String(v)===String(t):op==="not_equals"?String(v)!==String(t):op==="is_not_empty"?!!v:op==="is_empty"?!v:true; if(!pass) return false; } return true; };
  function buildProps(cu,ct){ const props={}; for(const m of mappings){ let v; const sf=m.sourceField||""; if(sf.startsWith("__fixed:")) v=sf.slice(8); else if(m.targetField==="cin7_parent_customer_id") v=cu.ID; else if(sf==="ID") v=cu.ID; else if(sf.startsWith("Contacts.")) v=ct[sf.split(".")[1]]; else v=cu[sf]; if(v==null) continue; if(m.targetField==="firstname") v=splitName(v,m.splitSeparator).first; else if(m.targetField==="lastname") v=splitName(v,m.splitSeparator).last; props[m.targetField]=v; }
    // NAME-SPLIT FALLBACK: the firstname mapping keeps only the first word of Contacts.Name.
    // If the config has no explicit lastname mapping, derive lastname from the same Name so a
    // rename in Cin7 fully propagates (an empty string clears a stale HubSpot Last Name).
    if (props.firstname !== undefined && !mappings.some(m=>m.targetField==="lastname")) {
      const _fm = mappings.find(m=>m.targetField==="firstname");
      const _src = _fm && String(_fm.sourceField||"").startsWith("Contacts.") ? ct[String(_fm.sourceField).split(".")[1]] : null;
      if (_src != null) props.lastname = splitName(_src).last;
    }
    // PHONE FALLBACK: if the config has no explicit phone mapping, map Contacts.Phone -> phone
    // (empty string clears a stale HubSpot phone when it's removed in Cin7).
    if (!mappings.some(m=>m.targetField==="phone") && ct.Phone != null) props.phone = ct.Phone;
    for(const cf of customFields){ const rawT=cf.customPropertyName||cf.targetField; if(!rawT||cf.sourceField==null||cf.sourceField==="") continue; const tgt=sanitizeProp(rawT); if(props[tgt]!==undefined) continue; const sf=String(cf.sourceField); let v= sf.startsWith("__fixed:")?sf.slice(8):(sf.startsWith("Contacts.")?ct[sf.split(".")[1]]:(sf==="ID"?cu.ID:cu[sf])); if(v==null) continue; props[tgt]=v; }
    return props; }
  const _comp={};
  async function companyFor(custId){ if(!custId) return null; if(custId in _comp) return _comp[custId]; let id=null; try{ const cs=await fastn.connector.hubspot.searchCompanies({filterGroups:[{filters:[{propertyName:"cin7_external_company_id",operator:"EQ",value:String(custId)}]}],sorts:[],query:"",properties:["cin7_external_company_id"],limit:1,after:"0"}); id=cs?.output?.results?.[0]?.id||null; }catch(e){} if(!id) id=await fastn.state.get(`c7hs:idmap:customer:c2h:${custId}`); _comp[custId]=id||null; return _comp[custId]; }
  async function link(contactId, companyId){ if(!contactId||!companyId) return; try{ await fastn.connector.hubspot.createDefaultAssociation({fromObjectType:"contacts",fromObjectId:String(contactId),toObjectType:"companies",toObjectId:String(companyId)}); }catch(e){} }
  async function searchByExt(contactId){ try{ const s=await fastn.connector.hubspot.searchContacts({filterGroups:[{filters:[{propertyName:"cin7_external_id",operator:"EQ",value:String(contactId)}]}],sorts:[],query:"",properties:["cin7_external_id"],limit:1,after:"0"}); return s?.output?.results?.[0]?.id||null; }catch(e){return null;} }

  for (const custId of ids){
    try {
      const r = await fastn.connector.cin7core.listCustomers({ ID:String(custId), Limit:1, IncludeDeprecated:true });
      const cu = r.output?.CustomerList?.[0];
      if(!cu){ result.skipped++; result.details.push({custId, reason:"customer not found"}); continue; }
      if(String(cu.Status)==="Deprecated"){ for(const ct of (cu.Contacts||[])){ const contactId=ct.ID; if(!contactId) continue; let hsId=await searchByExt(contactId)||await fastn.state.get(IDMAP(contactId)); if(hsId){ try{ await fastn.connector.hubspot.archiveContact({contactId:String(hsId)}); result.archived=(result.archived||0)+1; }catch(e){ result.errors++; } await fastn.state.delete(IDMAP(contactId)).catch(()=>{}); await fastn.state.delete(HASH(contactId)).catch(()=>{}); } } result.details.push({custId, action:"archived contacts (deprecated)"}); continue; }
      if(!evalConditions(cu)){ result.skipped++; result.details.push({custId, reason:"customer condition (not Active)"}); continue; }
      for (const ct of (cu.Contacts||[])){
        try {
          const contactId=ct.ID; if(!contactId){ result.skipped++; continue; }
          const props=buildProps(cu,ct);
          if(!props.email || !(props.firstname||props.lastname)){ result.skipped++; result.details.push({contactId, custId, reason:"skipped: contact missing name or email (both required to match)"}); continue; }
          // TOMBSTONE: if this contact was deleted (either side) in the last 15 min, do not resurrect it.
          const _tomb = await fastn.state.get(`c7hs:tombstone:contact:${String(props.email).trim().toLowerCase()}`).catch(()=>null);
          if (_tomb && (Date.now() - new Date(_tomb).getTime()) < 15*60*1000) { result.skipped++; result.details.push({contactId, custId, reason:"skipped: tombstoned (recently deleted)"}); continue; }
          Object.keys(props).forEach(k=>{ if(props[k]==null) delete props[k]; });
          const hashVal=JSON.stringify(props); const prior=await fastn.state.get(HASH(contactId));
          let hsId=await fastn.state.get(IDMAP(contactId));
          if(hsId&&prior===hashVal){ const f=await searchByExt(contactId); if(f){ result.skipped++; continue; } hsId=null; }
          if(!hsId) hsId=await searchByExt(contactId);
          // Email+Name dedupe fallback (config strategy). Skip whichever key is empty. cin7_external_id stays primary above.
          if(!hsId){ try{ const nf=[{propertyName:"email",operator:"EQ",value:String(props.email)}]; if(props.firstname) nf.push({propertyName:"firstname",operator:"EQ",value:String(props.firstname)}); if(props.lastname) nf.push({propertyName:"lastname",operator:"EQ",value:String(props.lastname)}); const sn=await fastn.connector.hubspot.searchContacts({filterGroups:[{filters:nf}],sorts:[],query:"",properties:["email"],limit:1,after:"0"}); hsId=sn?.output?.results?.[0]?.id||null; }catch(e){} }
          if(!hsId){
            // CREATE-LOCK ELECTION: duplicate Cin7 events run this handler concurrently — elect ONE
            // creator per email (same race class that created duplicate Cin7 sales from one deal).
            const LOCKC = `c7hs:lock:contactcreate:${String(props.email).toLowerCase()}`;
            const runTag = Date.now() + "-" + Math.random().toString(36).slice(2,10);
            const priorLock = await fastn.state.get(LOCKC);
            const priorTs = priorLock ? Number(String(priorLock).split("-")[0]) : 0;
            if (priorTs && (Date.now() - priorTs) < 120000) { result.skipped++; result.details.push({contactId, custId, reason:"skipped: concurrent run holds the contact-create lock"}); continue; }
            await fastn.state.set(LOCKC, runTag);
            { const _s = Date.now(); while (Date.now() - _s < 700) {} } // let simultaneous claimants converge
            if ((await fastn.state.get(LOCKC)) !== runTag) { result.skipped++; result.details.push({contactId, custId, reason:"skipped: lost contact-create lock election to a concurrent run"}); continue; }
            hsId = await searchByExt(contactId) || await fastn.state.get(IDMAP(contactId)) || null; // final re-check after winning the lock
          }
          if(hsId){
            try { await fastn.connector.hubspot.updateContact({contactId:hsId,properties:props}); result.updated++; }
            catch(e){
              // SELF-HEAL: stale idmap (mapped contact no longer exists in this portal).
              // Re-resolve by cin7_external_id, then email; update the match or create fresh.
              hsId=null;
              try{ const sf=await fastn.connector.hubspot.searchContacts({filterGroups:[{filters:[{propertyName:"cin7_external_id",operator:"EQ",value:String(contactId)}]}],sorts:[],query:"",properties:["cin7_external_id"],limit:1,after:"0"}); hsId=sf?.output?.results?.[0]?.id||null; }catch(e2){}
              if(!hsId&&props.email){ try{ const se=await fastn.connector.hubspot.searchContacts({filterGroups:[{filters:[{propertyName:"email",operator:"EQ",value:String(props.email)}]}],sorts:[],query:"",properties:["email"],limit:1,after:"0"}); hsId=se?.output?.results?.[0]?.id||null; }catch(e3){} }
              if(hsId){ await fastn.connector.hubspot.updateContact({contactId:hsId,properties:props}); result.updated++; }
              else { const c=await fastn.connector.hubspot.createContact({properties:props}); hsId=c.output?.id; result.created++; }
            }
          }
          else { try{ const c=await fastn.connector.hubspot.createContact({properties:props}); hsId=c.output?.id; result.created++; }catch(e){ if(props.email){ const se=await fastn.connector.hubspot.searchContacts({filterGroups:[{filters:[{propertyName:"email",operator:"EQ",value:String(props.email)}]}],sorts:[],query:"",properties:["email"],limit:1,after:"0"}).catch(()=>null); const fe=se?.output?.results?.[0]?.id; if(fe){ await fastn.connector.hubspot.updateContact({contactId:fe,properties:props}); hsId=fe; result.updated++; } else throw e; } else throw e; } }
          if(hsId){ await fastn.state.set(IDMAP(contactId),String(hsId)); await fastn.state.set(HASH(contactId),hashVal); const co=await companyFor(cu.ID); if(co) await link(hsId,co); }
        } catch(e){ result.errors++; result.details.push({contactId:ct.ID, custId, reason:"contact sync failed", errorMessage:String(e).slice(0,150)}); }
      }
      // REMOVAL SWEEP: a contact deleted from an ACTIVE Cin7 customer should be archived in HubSpot too.
      // Finds HubSpot contacts stamped cin7_parent_customer_id=<this customer> whose cin7_external_id
      // is no longer present in the customer's current Contacts[]. Contacts without cin7_external_id
      // are never touched (protects not-yet-stamped records from race conditions).
      try {
        const liveIds = new Set((cu.Contacts||[]).map(x=>String(x.ID)).filter(Boolean));
        let after = "0";
        for (let page=0; page<10; page++) {
          const sr = await fastn.connector.hubspot.searchContacts({ filterGroups:[{filters:[{propertyName:"cin7_parent_customer_id",operator:"EQ",value:String(cu.ID)}]}], sorts:[], query:"", properties:["cin7_external_id","email"], limit:100, after });
          const rows = sr?.output?.results||[];
          for (const row of rows) {
            const ext = row?.properties?.cin7_external_id;
            if (!ext || liveIds.has(String(ext))) continue;
            try {
              await fastn.connector.hubspot.archiveContact({ contactId: String(row.id) });
              result.removed = (result.removed||0)+1;
              // TOMBSTONE: deletion wins for 15 min — blocks any sync from re-creating this contact on either side.
              const _em = String(row?.properties?.email||"").trim().toLowerCase();
              if (_em) await fastn.state.set(`c7hs:tombstone:contact:${_em}`, new Date().toISOString());
              result.details.push({ custId, cin7ContactId: String(ext), hsContactId: String(row.id), action: "archived (contact removed in Cin7)" });
            } catch(e){ result.errors++; result.details.push({ custId, hsContactId: String(row.id), reason: "archive failed", errorMessage: String(e).slice(0,150) }); }
            await fastn.state.delete(IDMAP(String(ext))).catch(()=>{});
            await fastn.state.delete(HASH(String(ext))).catch(()=>{});
          }
          after = sr?.output?.paging?.next?.after;
          if (!after) break;
        }
      } catch(e){ result.errors++; result.details.push({ custId, reason:"removal sweep failed", errorMessage:String(e).slice(0,150) }); }
    } catch(e){ result.errors++; result.details.push({custId, reason:"customer sync failed", errorMessage:String(e).slice(0,150)}); }
  }
  return result;
}