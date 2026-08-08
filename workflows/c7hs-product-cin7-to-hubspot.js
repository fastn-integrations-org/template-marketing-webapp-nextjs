export default async function (ctx) {
  const TEMPLATE_ID = "cfg_0a958721d430"; // getByTemplate resolves the installation's clone
  const SOURCE_ENTITY = "product", SOURCE_CONN = "cin7core";
  const TARGET_ENTITY = "product", TARGET_CONN = "hubspot";
  const CURSOR_KEY = "c7hs:cursor:product:cin7-to-hubspot";
  const IDMAP = (cin7Id) => `c7hs:idmap:product:c2h:${cin7Id}`;
  const HASH = (cin7Id) => `c7hs:hash:product:c2h:${cin7Id}`;

  // Ambient `fastn` global — connector calls route to the installation's connections.
  const input = ctx.input || {};
  const directIds = (input.productId != null ? [String(input.productId)] : [])
    .concat(Array.isArray(input.productIds) ? input.productIds.map(String) : []);
  const directSkus = (input.sku != null ? [String(input.sku)] : [])
    .concat(Array.isArray(input.skus) ? input.skus.map(String) : []);
  const isDirect = directIds.length > 0 || directSkus.length > 0;
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
  if (!dir) return { error: "product entity not found in config", created:0, updated:0, skipped:0, errors:0, errorDetails:[] };
  // Outbound (Cin7 -> HubSpot): mappings stored cin7(source)->hubspot(target); use 'both' + 'outbound', skip 'inbound'-only.
  const mappings = (dir.mappings || []).filter(m => (m.syncDirection || "both") !== "inbound");
  const conditions = dir.conditions || [];
  const customFields = dir.customFields || [];

  const elig = (config.eligibility && config.eligibility.product) || {};
  const included = Array.isArray(elig.included) ? elig.included : [];
  const excluded = Array.isArray(elig.excluded) ? elig.excluded : [];
  function eligible(id) {
    if (included.length && !included.includes(id)) return false;
    if (excluded.length && excluded.includes(id)) return false;
    return true;
  }

  function getPath(obj, path) {
    if (path == null) return undefined;
    return String(path).split(".").reduce((o,k)=> (o==null?undefined:o[k]), obj);
  }
  function evalConditions(rec) {
    for (const c of conditions) {
      const v = getPath(rec, c.field); const target = c.value;
      const op = c.operator;
      const pass = op==="equals" ? String(v)===String(target)
        : op==="not_equals" ? String(v)!==String(target)
        : op==="contains" ? String(v??"").includes(target)
        : op==="not_contains" ? !String(v??"").includes(target)
        : op==="greater_than" ? Number(v)>Number(target)
        : op==="less_than" ? Number(v)<Number(target)
        : op==="is_empty" ? !v
        : op==="is_not_empty" ? !!v
        : op==="in" ? String(target).split(",").map(s=>s.trim()).includes(String(v))
        : op==="not_in" ? !String(target).split(",").map(s=>s.trim()).includes(String(v))
        : true;
      if (!pass) return false;
    }
    return true;
  }
  function applyTransform(rec, m) {
    // CONDITIONAL mapping (widget "Conditional value"): evaluate conditionRows against the
    // record FIRST — the __fixed value is only the "Otherwise" fallback, not the answer.
    if (m.mappingMode === "conditional" && m.conditionField && Array.isArray(m.conditionRows) && m.conditionRows.length) {
      const cv = String(getPath(rec, m.conditionField) ?? "").trim().toLowerCase();
      const row = m.conditionRows.find(r => String((r && r.sourceValue) ?? "").trim().toLowerCase() === cv);
      if (row) return row.targetValue;
      if (m.conditionElseField != null && m.conditionElseField !== "") return m.conditionElseField;
    }
    if (typeof m.sourceField === "string" && m.sourceField.startsWith("__fixed:")) return m.sourceField.slice(8);
    const t = m.transform || m.condition;
    if (t && t.type === "combine") return (t.fields||[]).map(f=>getPath(rec,f.field)).filter(v=>v!=null&&v!=="").join(t.separator||" ");
    if (t && t.type === "fallback") { const a=getPath(rec,m.sourceField); return (a!=null&&a!=="")?a:getPath(rec,t.fallbackField); }
    if (t && t.type === "conditional") {
      const w=t.when||{}; const wv=getPath(rec,w.field);
      const passes = w.operator==="equals"?String(wv)===String(w.value):w.operator==="is_empty"?!wv:w.operator==="is_not_empty"?!!wv:w.operator==="contains"?String(wv??"").includes(w.value):true;
      return passes ? getPath(rec,t.thenField) : getPath(rec,t.elseField);
    }
    if (Array.isArray(m.valueMappings) && m.valueMappings.length && !m.sourceField) return m.valueMappings[0].targetValue;
    if (Array.isArray(m.valueMappings) && m.valueMappings.length) {
      const map = Object.fromEntries(m.valueMappings.map(vm=>[vm.sourceValue,vm.targetValue]));
      const sv = getPath(rec, m.sourceField); return map[sv] ?? sv;
    }
    return getPath(rec, m.sourceField);
  }
  const PRODUCT_TYPE_DEFAULT = (config.product && config.product.cin7ProductType) || "inventory";
  function normProductType(v) {
    const s = String(v||"").toLowerCase();
    if (s === "stock" || s === "inventory") return "inventory";
    if (s === "non-stock" || s === "nonstock" || s === "non_inventory") return "non_inventory";
    if (s === "service") return "service";
    return PRODUCT_TYPE_DEFAULT;
  }
  const sanitizeProp=(n)=>{ let s=String(n||"").trim().toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"").replace(/_+/g,"_"); if(!s) s="custom_property"; if(!/^[a-z]/.test(s)) s="p_"+s; return s; };
  function buildProps(rec) {
    const props = {};
    for (const m of mappings) {
      let val = applyTransform(rec, m);
      if (val === undefined) continue;
      if (m.targetField === "hs_product_type") val = normProductType(val);
      props[m.targetField] = val;
    }
    for (const cf of customFields) {
      if (!cf || !cf.customPropertyName) continue;
      const sf = cf.sourceField || "";
      let val = sf.startsWith("__fixed:") ? sf.slice(8) : getPath(rec, sf);
      if (val === undefined || val === null || val === "") continue;
      props[sanitizeProp(cf.customPropertyName)] = val;
    }
    return props;
  }

  const result = { created:0, updated:0, skipped:0, errors:0, errorDetails:[], details:[] };
  const note = (p, action, reason) => { const e = { productId: p && (p.ID!=null?String(p.ID):null), sku: (p && p.SKU) || null, name: (p && p.Name) || null, action, reason: reason||null }; result.details.push(e); try { console.log("[product "+(e.sku||e.productId)+"] "+action+(reason?(" — "+reason):"")); } catch(_){} };

  // Ensure custom HubSpot product properties exist. Read the existing property list
  // FIRST and only create what's missing — an already-existing property is a normal
  // state, not an error, so we never fire a createProperty that would 409 in the trace.
  {
    const existingProps = new Set();
    try {
      const lp = await fastn.connector.hubspot.listProperties({ objectType: "products" });
      const arr = (lp && lp.output && (Array.isArray(lp.output) ? lp.output : lp.output.results)) || [];
      for (const p of arr) { if (p && p.name) existingProps.add(String(p.name)); }
    } catch (e) { /* listing failed -> fall back to best-effort creates below */ }
    for (const cf of customFields) {
      if (!cf || !cf.customPropertyName) continue;
      const nm = sanitizeProp(cf.customPropertyName);
      if (existingProps.has(nm)) continue; // already exists -> nothing to do, just map
      try { await fastn.connector.hubspot.createProperty({ objectType:"products", name: nm, label: cf.customPropertyName || cf.sourceLabel, type: cf.type || "string", fieldType: "text", groupName: "productinformation" }); }
      catch(e){ /* creation race -> ignore */ }
    }
  }

  async function searchByCin7Id(pid){
    try { const s = await fastn.connector.hubspot.searchProducts({ filterGroups:[{filters:[{propertyName:"cin7_product_id",operator:"EQ",value:String(pid)}]}], sorts:[], query:"", properties:["cin7_product_id"], limit:1, after:"0" }); return s?.output?.results?.[0]?.id || null; } catch(e){ return null; }
  }
  async function searchBySku(sku){
    if (!sku) return null;
    try { const s = await fastn.connector.hubspot.searchProducts({ filterGroups:[{filters:[{propertyName:"hs_sku",operator:"EQ",value:String(sku)}]}], sorts:[], query:"", properties:["hs_sku"], limit:1, after:"0" }); return s?.output?.results?.[0]?.id || null; } catch(e){ return null; }
  }

  async function syncProduct(p){
    if (!eligible(p.ID)) { result.skipped++; note(p, "skipped", "excluded by the config eligibility list"); return; }
    if (!evalConditions(p)) { result.skipped++; note(p, "skipped", "config filter/condition not met (e.g. Status is not Active)"); return; }
    const hashVal = JSON.stringify(buildProps(p));
    const priorHash = await fastn.state.get(HASH(p.ID));
    let targetId = await fastn.state.get(IDMAP(p.ID));
    if (targetId && priorHash === hashVal) {
      const f = await searchByCin7Id(p.ID);
      if (f) { result.skipped++; note(p, "skipped", "unchanged since last sync (hash match) — product already in HubSpot"); return; }
      await fastn.state.delete(IDMAP(p.ID)).catch(()=>{});
      await fastn.state.delete(HASH(p.ID)).catch(()=>{});
      targetId = null;
    }
    const props = buildProps(p);
    Object.keys(props).forEach(k => { if (props[k]==null) delete props[k]; });
    if (!targetId){ targetId = await searchByCin7Id(p.ID) || await searchBySku(props.hs_sku); }

    if (targetId) {
      try { await fastn.connector.hubspot.updateProduct({ productId: targetId, properties: props }); result.updated++; note(p, "updated", "existing HubSpot product updated"); }
      catch(e) {
        const found = await searchByCin7Id(p.ID) || await searchBySku(props.hs_sku);
        if (found) { await fastn.connector.hubspot.updateProduct({ productId: found, properties: props }); targetId = found; result.updated++; note(p, "updated", "matched existing product by cin7_product_id/SKU (self-heal)"); }
        else { const c = await fastn.connector.hubspot.createProduct({ properties: props }); targetId = c.output?.id; result.created++; note(p, "created", "new HubSpot product created"); }
      }
    } else {
      try { const c = await fastn.connector.hubspot.createProduct({ properties: props }); targetId = c.output?.id; result.created++; note(p, "created", "new HubSpot product created"); }
      catch(e) {
        const found = await searchByCin7Id(p.ID) || await searchBySku(props.hs_sku);
        if (found) { await fastn.connector.hubspot.updateProduct({ productId: found, properties: props }); targetId = found; result.updated++; note(p, "updated", "matched existing product by cin7_product_id/SKU (self-heal)"); }
        else throw e;
      }
    }
    if (targetId) { await fastn.state.set(IDMAP(p.ID), String(targetId)); await fastn.state.set(HASH(p.ID), hashVal); }
  }

  if (isDirect){
    const seen = new Set();
    const fetchOne = async (params) => { try { const r = await fastn.connector.cin7core.listProducts({ ...params, Limit:1 }); return r.output?.Products?.[0] || null; } catch(e){ return null; } };
    for (const id of directIds){
      try { const p = await fetchOne({ ID:id }); if (!p){ result.skipped++; note({ID:id}, "skipped", "product not found in Cin7 by ID"); continue; } if (seen.has(p.ID)) continue; seen.add(p.ID); await syncProduct(p); }
      catch(e){ result.errors++; result.errorDetails.push({ sourceId:id, reason:"direct sync failed", errorMessage:String(e).slice(0,200) }); }
    }
    for (const sku of directSkus){
      try { const p = await fetchOne({ Sku:sku }); if (!p){ result.skipped++; note({SKU:sku}, "skipped", "product not found in Cin7 by SKU"); continue; } if (seen.has(p.ID)) continue; seen.add(p.ID); await syncProduct(p); }
      catch(e){ result.errors++; result.errorDetails.push({ sku, reason:"direct sync failed", errorMessage:String(e).slice(0,200) }); }
    }
    return { ...result, mode:"direct", productIds: directIds, skus: directSkus };
  }

  // FULL-SCAN MODE: incremental ModifiedSince cursor removed by request — every run scans ALL
  // Cin7 products. Unchanged products are still skipped by the hash dedupe (no HubSpot writes).
  // Pass input.modifiedSince (or productId/sku) to bound a manual run.
  const cursor = input.modifiedSince || null;
  let newCursorMax = cursor;
  let page = 1;
  while (page <= maxPages) {
    const params = { Limit: limit, Page: page };
    if (cursor) params.ModifiedSince = cursor;
    let resp;
    try { resp = await fastn.connector.cin7core.listProducts(params); }
    catch(e){ result.errors++; result.errorDetails.push({ page, reason:"listProducts failed", errorMessage:String(e).slice(0,200) }); break; }
    const products = resp.output?.Products || [];
    if (products.length === 0) break;
    for (const p of products) {
      try {
        if (p.LastModifiedOn && (!newCursorMax || new Date(p.LastModifiedOn) > new Date(newCursorMax))) newCursorMax = p.LastModifiedOn;
        await syncProduct(p);
      } catch(e) { result.errors++; note(p, "error", "sync failed: "+String(e).slice(0,120)); result.errorDetails.push({ sourceId: p.ID, reason:"sync failed", errorMessage:String(e).slice(0,200) }); }
    }
    if (products.length < limit) break;
    page++;
  }
  // cursor no longer persisted — full scan every run
  return result;
}