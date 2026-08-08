export default async function (ctx) {
  // Installation-aware: ambient fastn routes connectors through the installation's
  // connections; config resolves the per-installation clone from the widget template.
  const TEMPLATE_ID="cfg_0a958721d430";
  const IDMAP=(id)=>`c7hs:idmap:customer:c2h:${id}`;
  const HASH=(id)=>`c7hs:hash:customer:c2h:${id}`;

  const input=ctx.input||{}; const ids=new Set();
  const add=(v)=>{ if(v!=null&&String(v).trim()!=="") ids.add(String(v)); };
  if(input.customerId) add(input.customerId);
  if(Array.isArray(input.customerIds)) input.customerIds.forEach(add);
  const scan=(e)=>{ if(!e||typeof e!=="object") return; add(e.CustomerID); add(e.ID);
    for(const k of Object.keys(e)){ if(/DetailsList$/.test(k)&&Array.isArray(e[k])) e[k].forEach(x=>{ if(x){ add(x.ID); add(x.CustomerID); add(x.Customer&&x.Customer.ID); } }); } };
  if(Array.isArray(input)) input.forEach(scan); else scan(input);
  const result={created:0,updated:0,linked:0,skipped:0,errors:0,details:[]};
  const custIds=[...ids];
  if(!custIds.length) return {...result, reason:"no CustomerID in payload"};

  const cfg=(await fastn.config.getByTemplate(TEMPLATE_ID).catch(()=>null))||(await fastn.config.get(TEMPLATE_ID));
  const flows=cfg.entities||[];
  const dir=flows.find(d=>d.source?.entity==="customer"&&d.source?.connector==="cin7core"&&d.target?.entity==="company");
  if(!dir) return {...result, error:"customer->company direction not found"};
  // Outbound (Cin7 -> HubSpot) handler: apply only 'both'/'outbound' mappings; 'inbound'
  // mappings (incl. fixed values) target Cin7 fields and must never be written to HubSpot.
  const mappings=(dir.mappings||[]).filter(m=>(m.syncDirection||"both")!=="inbound"); const conditions=dir.conditions||[]; const customFields=dir.customFields||[];

  // Sanitize a user-supplied custom property name into a valid HubSpot internal name.
  const sanitizeProp=(n)=>{ let s=String(n||"").trim().toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"").replace(/_+/g,"_"); if(!s) s="custom_property"; if(!/^[a-z]/.test(s)) s="p_"+s; return s; };

  // Ensure custom props exist: read existing ones first, only create what's missing
  // (an already-existing property is normal — never fire a createProperty that 409s).
  {
    const existingProps=new Set();
    try{ const lp=await fastn.connector.hubspot.listProperties({objectType:"companies"}); const arr=(lp&&lp.output&&(Array.isArray(lp.output)?lp.output:lp.output.results))||[]; for(const p of arr){ if(p&&p.name) existingProps.add(String(p.name)); } }catch(e){}
    for(const cf of customFields){ const raw=cf.customPropertyName||cf.targetField; if(!raw) continue; const nm=sanitizeProp(raw); if(existingProps.has(nm)) continue; try{ await fastn.connector.hubspot.createProperty({objectType:"companies",name:nm,label:raw,type:cf.type||"string",fieldType:"text",groupName:"companyinformation"}); }catch(e){} }
  }

  const normAddrType=(t)=>{ const s=String(t||"").toLowerCase(); if(s==="shipment"||s==="shipping") return "Shipping"; if(s==="billing") return "Billing"; if(s==="business") return "Business"; return t; };
  const ADDRESS_TYPE=(conditions.find(c=>c.field==="addressType")||{}).value||null;
  const defaultAddress=(rec)=>{ const a=rec.Addresses||[]; const want=(typeof ADDRESS_TYPE==="string"&&ADDRESS_TYPE)?normAddrType(ADDRESS_TYPE):null; if(want){ const of=a.filter(x=>String(x.Type)===want); const p=of.find(x=>x.DefaultForType)||of[0]; if(p) return p; } return a.find(x=>x.DefaultForType)||a[0]||{}; };
  const defaultContact=(rec)=>{ const c=rec.Contacts||[]; return c.find(x=>x.Default)||c[0]||{}; };
  const getPath=(obj,path)=>{ if(path==null) return undefined; if(String(path).startsWith("__fixed:")) return String(path).slice(8); const parts=String(path).split("."); if(parts[0]==="Addresses") return defaultAddress(obj)[parts[1]]; if(parts[0]==="Contacts") return defaultContact(obj)[parts[1]]; return parts.reduce((o,k)=>(o==null?undefined:o[k]),obj); };
  const evalConditions=(rec)=>{ for(const c of conditions){ if(c.field==="addressType") continue; const v=getPath(rec,c.field); const op=c.operator; const t=c.value; const pass= op==="equals"?String(v)===String(t):op==="not_equals"?String(v)!==String(t):op==="is_not_empty"?!!v:op==="is_empty"?!v:true; if(!pass) return false; } return true; };
  const buildProps=(rec)=>{ const props={}; for(const m of mappings){ const val=getPath(rec,m.sourceField); if(val===undefined) continue; props[m.targetField]=val; } for(const cf of customFields){ const rawT=cf.customPropertyName||cf.targetField; if(!rawT||cf.sourceField==null||cf.sourceField==="") continue; const t=sanitizeProp(rawT); if(props[t]!==undefined) continue; const v=getPath(rec,cf.sourceField); if(v===undefined) continue; props[t]=v; } return props; };
  async function searchByCin7Id(cid){ try{ const s=await fastn.connector.hubspot.searchCompanies({filterGroups:[{filters:[{propertyName:"cin7_external_company_id",operator:"EQ",value:String(cid)}]}],sorts:[],query:"",properties:["cin7_external_company_id"],limit:1,after:"0"}); return s?.output?.results?.[0]?.id||null; }catch(e){return null;} }
  async function searchByName(name){ if(!name) return null; try{ const s=await fastn.connector.hubspot.searchCompanies({filterGroups:[{filters:[{propertyName:"name",operator:"EQ",value:String(name)}]}],sorts:[],query:"",properties:["name","cin7_external_company_id"],limit:5,after:"0"}); const r=s?.output?.results||[]; const u=r.find(x=>!x.properties?.cin7_external_company_id); return (u||r[0])?.id||null; }catch(e){return null;} }

  async function syncCustomer(cu){
    // Do NOT create a HubSpot company for a Cin7 customer that was created just to hold a HubSpot contact (person, not a company).
    const _origin = await fastn.state.get("c7hs:custorigin:"+String(cu.ID)); if(_origin==="hs-contact"){ result.skipped++; result.details.push({ custId: cu.ID, reason:"skipped: customer originated from a HubSpot contact, not a company" }); return; }
    if(!evalConditions(cu)){ result.skipped++; return; }
    const props=buildProps(cu);
    const hashVal=JSON.stringify(props);
    const prior=await fastn.state.get(HASH(cu.ID));
    let targetId=await fastn.state.get(IDMAP(cu.ID));
    if(targetId&&prior===hashVal){ const f=await searchByCin7Id(cu.ID); if(f){ result.skipped++; return; } targetId=null; }
    Object.keys(props).forEach(k=>{ if(props[k]==null) delete props[k]; });
    let linkedNow=false;
    if(!targetId){ targetId=await searchByCin7Id(cu.ID); if(!targetId){ const n=await searchByName(props.name||cu.Name); if(n){ targetId=n; linkedNow=true; } } }
    if(targetId){ if(props.cin7_external_company_id===undefined) props.cin7_external_company_id=String(cu.ID); try{ await fastn.connector.hubspot.updateCompany({companyId:targetId,properties:props}); if(linkedNow) result.linked++; else result.updated++; }catch(e){ const f=await searchByCin7Id(cu.ID)||await searchByName(props.name||cu.Name); if(f){ await fastn.connector.hubspot.updateCompany({companyId:f,properties:props}); targetId=f; result.updated++; } else { const c=await fastn.connector.hubspot.createCompany({properties:props}); targetId=c.output?.id; result.created++; } } }
    else { if(props.cin7_external_company_id===undefined) props.cin7_external_company_id=String(cu.ID); try{ const c=await fastn.connector.hubspot.createCompany({properties:props}); targetId=c.output?.id; result.created++; }catch(e){ const f=await searchByCin7Id(cu.ID)||await searchByName(props.name||cu.Name); if(f){ await fastn.connector.hubspot.updateCompany({companyId:f,properties:props}); targetId=f; result.updated++; } else throw e; } }
    if(targetId){ await fastn.state.set(IDMAP(cu.ID),String(targetId)); await fastn.state.set(HASH(cu.ID),hashVal); }
  }

  for(const custId of custIds){
    try{ const r=await fastn.connector.cin7core.listCustomers({ID:String(custId),Limit:1,IncludeDeprecated:true}); const cu=r.output?.CustomerList?.[0]; if(!cu){ result.skipped++; result.details.push({custId,reason:"not found"}); continue; } if(String(cu.Status)==="Deprecated"){ let cid=await searchByCin7Id(cu.ID)||await fastn.state.get(IDMAP(cu.ID)); if(cid){ try{ await fastn.connector.hubspot.archiveCompany({companyId:String(cid)}); result.archived=(result.archived||0)+1; result.details.push({custId, action:"archived company (deprecated)"}); }catch(e){ result.errors++; result.details.push({custId, reason:"archive failed", errorMessage:String(e).slice(0,150)}); } await fastn.state.delete(IDMAP(cu.ID)).catch(()=>{}); await fastn.state.delete(HASH(cu.ID)).catch(()=>{}); } else { result.skipped++; result.details.push({custId, reason:"deprecated, no mapped company"}); } continue; } await syncCustomer(cu); result.details.push({custId, name:cu.Name}); }
    catch(e){ result.errors++; result.details.push({custId, reason:"sync failed", errorMessage:String(e).slice(0,150)}); }
  }
  return result;
}