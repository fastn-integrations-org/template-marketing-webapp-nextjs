export default async function (ctx) {
  // Installation-aware: ambient fastn routes connectors through the installation's
  // connections; config resolves the per-installation clone from the widget template.
  const TEMPLATE_ID = "cfg_0a958721d430";
  const IDMAP = (id)=>`c7hs:idmap:sale:c2h:${id}`;
  const HASH = (id)=>`c7hs:hash:sale:c2h:${id}`;
  const LINES_DONE = (id)=>`c7hs:lines:sale:c2h:${id}`;
  const CUST_IDMAP = (id)=>`c7hs:idmap:customer:c2h:${id}`;
  const CONTACT_IDMAP = (id)=>`c7hs:idmap:contact:c2h:${id}`;

  const input = ctx.input || {};
  const ids = new Set();
  const addId = (v)=>{ if (v!=null && String(v).trim()!=="") ids.add(String(v)); };
  if (input.saleId) addId(input.saleId);
  if (Array.isArray(input.saleIds)) input.saleIds.forEach(addId);
  const scanEvt = (e)=>{ if(!e||typeof e!=="object") return; addId(e.SaleID); addId(e.ID);
    for (const k of Object.keys(e)){ if (/DetailsList$/.test(k) && Array.isArray(e[k])) e[k].forEach(x=>{ if(x){ addId(x.SaleID); addId(x.ID); addId(x.Sale&&x.Sale.ID); } }); } };
  if (Array.isArray(input)) input.forEach(scanEvt); else scanEvt(input);
  const saleIds = [...ids];
  const result = { voided:0, created:0, updated:0, skipped:0, errors:0, details:[], skippedDetails:[] };
  // SKIP LOG: every skipped sale is recorded with id, order number, customer and a human-readable
  // reason — surfaced in the run output (skippedDetails + details) AND the execution console logs.
  const skip = (saleId, d, reason, extra) => {
    result.skipped++;
    const entry = { saleId: String(saleId), orderNumber: d?.OrderNumber ?? d?.Order?.SaleOrderNumber ?? null, customer: d?.Customer ?? null, reason, ...(extra || {}) };
    result.skippedDetails.push(entry);
    result.details.push(entry);
    console.log(`[SKIP] sale ${entry.orderNumber || entry.saleId}${entry.customer ? ` (${entry.customer})` : ""} — ${reason}`);
  };
  if (!saleIds.length) return { ...result, reason:"no SaleID in payload" };

  const cfg = (await fastn.config.getByTemplate(TEMPLATE_ID).catch(()=>null))||(await fastn.config.get(TEMPLATE_ID));
  const flows = cfg.entities||[];
  const dir = flows.find(d=>d.source?.entity==="sale"&&d.target?.entity==="deal");
  const customFields = dir?.customFields||[];
  const se = flows.find(d=>d.source?.entity==="dealstage"&&d.target?.entity==="status");
  const stageMap={}; for(const m of (se?.mappings||[])){ if(m.targetField!=null&&m.sourceField!=null) stageMap[String(m.targetField).toUpperCase()]=m.sourceField; }
  const mapStage=(s)=> stageMap[String(s||"").toUpperCase()] || "appointmentscheduled";
  const num=(x)=> (x==null||x==="")?0:Number(x);
  // Sanitize a user-supplied custom property name into a valid HubSpot internal name, then ensure the deal property exists.
  const sanitizeProp=(n)=>{ let s=String(n||"").trim().toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"").replace(/_+/g,"_"); if(!s) s="custom_property"; if(!/^[a-z]/.test(s)) s="p_"+s; return s; };
  // Ensure custom props exist: read existing ones first, only create what's missing
  // (an already-existing property is normal — never fire a createProperty that 409s).
  {
    const existingProps=new Set();
    try{ const lp=await fastn.connector.hubspot.listProperties({objectType:"deals"}); const arr=(lp&&lp.output&&(Array.isArray(lp.output)?lp.output:lp.output.results))||[]; for(const p of arr){ if(p&&p.name) existingProps.add(String(p.name)); } }catch(e){}
    for (const cf of customFields){ const raw=cf.customPropertyName||cf.targetField; if(!raw) continue; const nm=sanitizeProp(raw); if(existingProps.has(nm)) continue; try{ await fastn.connector.hubspot.createProperty({objectType:"deals",name:nm,label:raw,type:cf.type||"string",fieldType:"text",groupName:"dealinformation"}); }catch(e){} }
  }

  async function findDeal(saleId){ try{ const d=await fastn.connector.hubspot.searchDeals({filterGroups:[{filters:[{propertyName:"cin7_sale_id",operator:"EQ",value:String(saleId)}]}],sorts:[],query:"",properties:["cin7_sale_id"],limit:1,after:"0"}); return d?.output?.results?.[0]?.id||null; }catch(e){return null;} }
  async function assoc(dealId,toType,toId,typeId){ if(!dealId||!toId) return; try{ await fastn.connector.hubspot.createAssociation({ fromObjectType:"deals", fromObjectId:String(dealId), toObjectType:toType, toObjectId:String(toId), types: JSON.stringify([{associationCategory:"HUBSPOT_DEFINED", associationTypeId:typeId}]) }); }catch(e){} }

  // Resolve the sale's Cin7 contact ID. getSale returns Contact as a NAME string (no ContactID /
  // Contacts[]), which used to make the gate treat the contact as missing and skip the sale
  // (e.g. SO-01927). Match the name/email against the customer's Contacts[]; fall back to the
  // Default contact. Cached per customer per run.
  const _custContacts = {};
  async function resolveCin7ContactId(d){
    const direct = d.ContactID || (d.Contact && d.Contact.ID) || (Array.isArray(d.Contacts) ? (d.Contacts.find(c=>c.Default)||d.Contacts[0])?.ID : null);
    if (direct) return direct;
    const custId = d.CustomerID;
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

  for (const saleId of saleIds){
    try {
      const d = (await fastn.connector.cin7core.getSale({ ID:String(saleId) })).output || {};
      if (!d.SaleID && !d.ID){ skip(saleId, d, "sale not found in Cin7 (getSale returned nothing for this SaleID)"); continue; }
      const status = String(d.Status||"").toUpperCase();

      if (status==="VOIDED"){
        let dealId = await findDeal(saleId) || await fastn.state.get(IDMAP(saleId));
        if (dealId){ try{ await fastn.connector.hubspot.updateDeal({ dealId:String(dealId), properties:{ dealstage: mapStage("VOIDED") } }); result.voided++; result.details.push({saleId, action:"voided->"+mapStage("VOIDED"), dealId}); }catch(e){ result.errors++; result.details.push({saleId, reason:"void update failed", errorMessage:String(e).slice(0,150)});} }
        else { skip(saleId, d, "sale is VOIDED and no matching HubSpot deal exists to move — nothing to sync"); }
        continue;
      }

      let company=null; try{ const cs=await fastn.connector.hubspot.searchCompanies({filterGroups:[{filters:[{propertyName:"cin7_external_company_id",operator:"EQ",value:String(d.CustomerID)}]}],sorts:[],query:"",properties:["cin7_external_company_id"],limit:1,after:"0"}); company=cs?.output?.results?.[0]?.id||null; }catch(e){}
      if(!company){ const _sid=await fastn.state.get(CUST_IDMAP(d.CustomerID)); if(_sid){ try{ const _gc=await fastn.connector.hubspot.getCompany({companyId:String(_sid)}); if(_gc?.output?.id && _gc.output.archived!==true) company=String(_sid); }catch(_ge){} } }
      const cin7ContactId = await resolveCin7ContactId(d);
      let contact=null; if(cin7ContactId){ try{ const s=await fastn.connector.hubspot.searchContacts({filterGroups:[{filters:[{propertyName:"cin7_external_id",operator:"EQ",value:String(cin7ContactId)}]}],sorts:[],query:"",properties:["cin7_external_id"],limit:1,after:"0"}); contact=s?.output?.results?.[0]?.id||null; }catch(e){} if(!contact){ const _sid=await fastn.state.get(CONTACT_IDMAP(cin7ContactId)); if(_sid){ try{ const _gc=await fastn.connector.hubspot.getContact({contactId:String(_sid)}); if(_gc?.output?.id && _gc.output.archived!==true) contact=String(_sid); }catch(_ge){} } } }
      const lines = (d.Order?.Lines||[]).filter(ln=> !((!ln.SKU||!String(ln.SKU).trim())&&(!ln.Name||!String(ln.Name).trim())));
      const lineProd = {}; let anyProduct=false; let _depsChanged=false;
      for (const ln of lines){ if(ln.SKU && !(ln.SKU in lineProd)){ try{ const sp=await fastn.connector.hubspot.searchProducts({filterGroups:[{filters:[{propertyName:"hs_sku",operator:"EQ",value:String(ln.SKU)}]}],sorts:[],query:"",properties:["hs_sku"],limit:1,after:"0"}); const pid=sp?.output?.results?.[0]?.id||null; if(pid){ lineProd[ln.SKU]=pid; anyProduct=true; } }catch(e){} } }
      if(!company){ try{ await fastn.flow.invoke("c7hs-evt-customer-cin7-to-hubspot", { customerId: String(d.CustomerID) }); _depsChanged=true; }catch(_ae){ try{ console.log("[sale "+(d.OrderNumber||saleId)+"] dep company create failed: "+String(_ae).slice(0,150)); }catch(_be){} } try{ company=(await fastn.state.get(CUST_IDMAP(d.CustomerID)))||company; }catch(_se){} if(!company){ try{ const _cs=await fastn.connector.hubspot.searchCompanies({filterGroups:[{filters:[{propertyName:"cin7_external_company_id",operator:"EQ",value:String(d.CustomerID)}]}],sorts:[],query:"",properties:["cin7_external_company_id"],limit:1,after:"0"}); company=_cs?.output?.results?.[0]?.id||company; }catch(_ce){} } }
      if(!contact && cin7ContactId){ try{ await fastn.flow.invoke("c7hs-evt-contact-cin7-to-hubspot", { customerId: String(d.CustomerID) }); _depsChanged=true; }catch(_ae){ try{ console.log("[sale "+(d.OrderNumber||saleId)+"] dep contact create failed: "+String(_ae).slice(0,150)); }catch(_be){} } try{ contact=(await fastn.state.get(CONTACT_IDMAP(cin7ContactId)))||contact; }catch(_se){} if(!contact){ try{ const _ct=await fastn.connector.hubspot.searchContacts({filterGroups:[{filters:[{propertyName:"cin7_external_id",operator:"EQ",value:String(cin7ContactId)}]}],sorts:[],query:"",properties:["cin7_external_id"],limit:1,after:"0"}); contact=_ct?.output?.results?.[0]?.id||contact; }catch(_ce){} } }
      { const _missSkus=[...new Set(lines.filter(ln=>ln.SKU && !lineProd[ln.SKU]).map(ln=>String(ln.SKU)))]; if(_missSkus.length){ try{ await fastn.flow.invoke("c7hs-evt-product-cin7-to-hubspot", { skus: _missSkus }); _depsChanged=true; }catch(_ae){ try{ console.log("[sale "+(d.OrderNumber||saleId)+"] dep product create failed: "+String(_ae).slice(0,150)); }catch(_be){} } for(const _ln of lines){ if(_ln.SKU && !lineProd[_ln.SKU]){ try{ const _pm=_ln.ProductID?(await fastn.state.get("c7hs:idmap:product:c2h:"+String(_ln.ProductID))):null; if(_pm){ lineProd[_ln.SKU]=_pm; anyProduct=true; } }catch(_se){} if(!lineProd[_ln.SKU]){ try{ const _sp=await fastn.connector.hubspot.searchProducts({filterGroups:[{filters:[{propertyName:"hs_sku",operator:"EQ",value:String(_ln.SKU)}]}],sorts:[],query:"",properties:["hs_sku"],limit:1,after:"0"}); const _pid=_sp?.output?.results?.[0]?.id||null; if(_pid){ lineProd[_ln.SKU]=_pid; anyProduct=true; } }catch(_ce){} } } } } }
      if(!contact){ try { console.log("[sale "+(d.OrderNumber||saleId)+"] contact not synced in HubSpot — proceeding with company-only association"); } catch(_e){} }
      if(!company||!anyProduct){ skip(saleId, d, "not yet syncable — missing in HubSpot: "+[!company?("company (Cin7 customer '"+(d.Customer||d.CustomerID)+"' has no synced HubSpot company)"):null,!anyProduct?"line-item product (no sale line SKU matches a HubSpot product)":null].filter(Boolean).join("; ")); continue; }

      const contactOrCustomer = (typeof d.Contact==="string" ? d.Contact : d.Contact?.Name) || d.Customer || "";
      const orderNum = d.OrderNumber || d.Order?.SaleOrderNumber || d.Quote?.SaleOrderNumber || String(saleId);
      const props = {
        dealname: contactOrCustomer ? (contactOrCustomer+" - "+orderNum) : orderNum,
        amount: num(d.Quote?.Total || d.Order?.Total || d.InvoiceAmount),
        dealstage: mapStage(status),
        pipeline: "default",
        cin7_sale_id: String(d.SaleID||saleId)
      };
      for (const cf of customFields){ const rawT=cf.customPropertyName||cf.targetField; if(!rawT||cf.sourceField==null||cf.sourceField==="") continue; const tgt=sanitizeProp(rawT); if(props[tgt]!==undefined) continue; const v = String(cf.sourceField).startsWith("__fixed:")?String(cf.sourceField).slice(8):d[cf.sourceField]; if(v!=null&&v!=="") props[tgt]=v; }
      Object.keys(props).forEach(k=>{ if(props[k]==null) delete props[k]; });

      const hashVal = JSON.stringify(props);
      const prior = await fastn.state.get(HASH(saleId));
      let dealId = await findDeal(saleId); if(!dealId){ const _sd=await fastn.state.get(IDMAP(saleId)); if(_sd){ try{ const _gd=await fastn.connector.hubspot.getDeal({dealId:String(_sd)}); if(_gd?.output?.id && _gd.output.archived!==true) dealId=String(_sd); }catch(_ge){} } }
      // Dedupe fallback: match an existing deal by dealname (carries the unique SO order number) to avoid duplicate deals.
      if(!dealId && props.dealname){ try{ const dn=await fastn.connector.hubspot.searchDeals({filterGroups:[{filters:[{propertyName:"dealname",operator:"EQ",value:String(props.dealname)}]}],sorts:[],query:"",properties:["dealname"],limit:1,after:"0"}); dealId=dn?.output?.results?.[0]?.id||null; }catch(e){} }
      let isNew = false;

      if (dealId && prior===hashVal && !_depsChanged){ skip(saleId, d, "already synced and unchanged since the last sync (nothing to update)", { dealId: String(dealId) }); continue; }

      if (dealId){ try{ await fastn.connector.hubspot.updateDeal({ dealId:String(dealId), properties:props }); result.updated++; }catch(e){ const f=await findDeal(saleId); if(f){ await fastn.connector.hubspot.updateDeal({dealId:String(f),properties:props}); dealId=f; result.updated++; } else { const c=await fastn.connector.hubspot.createDeal({properties:props}); dealId=c.output?.id; isNew=true; result.created++; } } }
      else { try{ const c=await fastn.connector.hubspot.createDeal({properties:props}); dealId=c.output?.id; isNew=true; result.created++; }catch(e){ const f=await findDeal(saleId); if(f){ await fastn.connector.hubspot.updateDeal({dealId:String(f),properties:props}); dealId=f; result.updated++; } else throw e; } }

      if (dealId){
        await fastn.state.set(IDMAP(saleId), String(dealId));
        await fastn.state.set(HASH(saleId), hashVal);
        await assoc(dealId, "companies", company, 5);
        await assoc(dealId, "contacts", contact, 3);
        if(isNew){ try{ await fastn.state.delete(LINES_DONE(saleId)); }catch(_le){} } const linesDone = await fastn.state.get(LINES_DONE(saleId));
        if (linesDone && dealId){
          // RECONCILE: line items were created on a previous event, but quantity/price may have
          // changed in Cin7 since (e.g. Sale/Created fired before quantities were entered).
          // Update existing HubSpot line items in place; never freeze the first snapshot.
          try {
            const _ex = await fastn.connector.hubspot.listAssociations({ fromObjectType:"deals", fromObjectId:String(dealId), toObjectType:"line_items", limit:100 });
            const _byKey = {};
            for (const _r of ((_ex.output&&_ex.output.results)||[])){
              try { const _g = await fastn.connector.hubspot.getLineItem({ lineItemId:String(_r.toObjectId), properties:"hs_sku,name,quantity,price" }); const _p=(_g.output&&_g.output.properties)||{}; const _k=String(_p.hs_sku||_p.name||"").trim().toLowerCase(); if(_k) _byKey[_k]={ id:String(_r.toObjectId), quantity:Number(_p.quantity), price:Number(_p.price) }; } catch(_e){}
            }
            for (const _ln of lines){
              const _k=String(_ln.SKU||_ln.Name||"").trim().toLowerCase();
              const _cur=_byKey[_k]; if(!_cur) continue;
              const _q=Number(_ln.Quantity), _pr=Number(_ln.Price); const _up={};
              if(!Number.isNaN(_q)&&_q!==_cur.quantity) _up.quantity=_q;
              if(!Number.isNaN(_pr)&&_pr!==_cur.price) _up.price=_pr;
              if(Object.keys(_up).length){ try{ await fastn.connector.hubspot.updateLineItem({ lineItemId:_cur.id, properties:_up }); } catch(_e2){} }
            }
          } catch(_e){}
        }
        if (!linesDone){
          for (const ln of lines){
            try {
              const liProps = { name: ln.Name||ln.SKU||"Line item", price: ln.Price, quantity: ln.Quantity };
              const pid = ln.SKU ? lineProd[ln.SKU] : null;
              if (pid) liProps.hs_product_id = pid;
              const li = await fastn.connector.hubspot.createLineItem({ properties: liProps });
              await assoc(dealId, "line_items", li.output?.id, 19);
            } catch(e){}
          }
          await fastn.state.set(LINES_DONE(saleId), "1");
        }
        result.details.push({saleId, action: isNew?"created":"updated", dealId, stage: props.dealstage });
      }
    } catch(e){ result.errors++; result.details.push({saleId, reason:"sync failed", errorMessage:String(e).slice(0,200)}); }
  }
  return result;
}