export default async function (ctx) {
  // Installation-aware: ambient fastn routes connectors through the installation's
  // connections; config resolves the per-installation clone from the widget template.
  const TEMPLATE_ID = "cfg_0a958721d430";
  const IDMAP = (id) => `c7hs:idmap:product:c2h:${id}`;
  const HASH = (id) => `c7hs:hash:product:c2h:${id}`;

  const input = ctx.input || {}; const pids = new Set(); const skus = new Set();
  const addP = (v) => { if (v != null && String(v).trim() !== "") pids.add(String(v)); };
  const addS = (v) => { if (v != null && String(v).trim() !== "") skus.add(String(v)); };
  if (input.productId) addP(input.productId); if (Array.isArray(input.productIds)) input.productIds.forEach(addP);
  if (input.sku) addS(input.sku); if (Array.isArray(input.skus)) input.skus.forEach(addS);
  const scan = (e) => {
    if (!e || typeof e !== "object") return; addP(e.ID); addP(e.ProductID); addS(e.SKU);
    for (const k of Object.keys(e)) { if (/DetailsList$/.test(k) && Array.isArray(e[k])) e[k].forEach(x => { if (x) { addP(x.ID); addP(x.ProductID); addS(x.SKU); } }); }
  };
  if (Array.isArray(input)) input.forEach(scan); else scan(input);
  const result = { created: 0, updated: 0, skipped: 0, errors: 0, details: [] };
  if (!pids.size && !skus.size) return { ...result, reason: "no product id/sku in payload" };

  const cfg = (await fastn.config.getByTemplate(TEMPLATE_ID).catch(() => null)) || (await fastn.config.get(TEMPLATE_ID));
  const flows = cfg.entities || [];
  const dir = flows.find(d => d.source?.entity === "product" && d.source?.connector === "cin7core" && d.target?.entity === "product" && d.target?.connector === "hubspot");
  if (!dir) return { ...result, error: "product direction not found" };
  // Outbound (Cin7 -> HubSpot) handler: exclude 'inbound' mappings (they target Cin7 fields).
  const mappings = (dir.mappings || []).filter(m => (m.syncDirection || "both") !== "inbound"); const conditions = dir.conditions || []; const customFields = dir.customFields || [];

  // Sanitize a user-supplied custom property name into a valid HubSpot internal name:
  // lowercase, only [a-z0-9_], must start with a letter. Already-valid names pass through unchanged.
  const sanitizeProp = (n) => { let s = String(n || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/_+/g, "_"); if (!s) s = "custom_property"; if (!/^[a-z]/.test(s)) s = "p_" + s; return s; };

  // Ensure custom props exist: read existing ones first, only create what's missing
  // (an already-existing property is normal — never fire a createProperty that 409s).
  {
    const existingProps = new Set();
    try { const lp = await fastn.connector.hubspot.listProperties({ objectType: "products" }); const arr = (lp && lp.output && (Array.isArray(lp.output) ? lp.output : lp.output.results)) || []; for (const p of arr) { if (p && p.name) existingProps.add(String(p.name)); } } catch (e) { }
    for (const cf of customFields) { const raw = cf.customPropertyName || cf.targetField; if (!raw) continue; const nm = sanitizeProp(raw); if (existingProps.has(nm)) continue; try { await fastn.connector.hubspot.createProperty({ objectType: "products", name: nm, label: raw, type: cf.type || "string", fieldType: "text", groupName: "productinformation" }); } catch (e) { } }
  }

  const getPath = (obj, path) => { if (path == null) return undefined; return String(path).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj); };
  const evalConditions = (rec) => { for (const c of conditions) { const v = getPath(rec, c.field); const t = c.value; const op = c.operator; if ((t == null || t === "") && op !== "is_empty" && op !== "is_not_empty") continue; const pass = op === "equals" ? String(v) === String(t) : op === "not_equals" ? String(v) !== String(t) : op === "is_not_empty" ? !!v : op === "is_empty" ? !v : true; if (!pass) return false; } return true; };
  const applyTransform = (rec, m) => {
    // CONDITIONAL mapping (widget "Conditional value"): evaluate conditionRows against the
    // record FIRST — the __fixed value is only the "Otherwise" fallback, not the answer.
    if (m.mappingMode === "conditional" && m.conditionField && Array.isArray(m.conditionRows) && m.conditionRows.length) {
      const cv = String(getPath(rec, m.conditionField) ?? "").trim().toLowerCase();
      const row = m.conditionRows.find(r => String((r && r.sourceValue) ?? "").trim().toLowerCase() === cv);
      if (row) return row.targetValue;
      if (m.conditionElseField != null && m.conditionElseField !== "") return m.conditionElseField;
    }
    if (typeof m.sourceField === "string" && m.sourceField.startsWith("__fixed:")) return m.sourceField.slice(8); if (Array.isArray(m.valueMappings) && m.valueMappings.length && !m.sourceField) return m.valueMappings[0].targetValue; if (Array.isArray(m.valueMappings) && m.valueMappings.length) { const map = Object.fromEntries(m.valueMappings.map(vm => [vm.sourceValue, vm.targetValue])); const sv = getPath(rec, m.sourceField); return map[sv] ?? sv; } return getPath(rec, m.sourceField);
  };
  const PT_DEFAULT = (cfg.product && cfg.product.cin7ProductType) || "inventory";
  const normPT = (v) => { const s = String(v || "").toLowerCase(); if (s === "stock" || s === "inventory") return "inventory"; if (s === "non-stock" || s === "nonstock" || s === "non_inventory") return "non_inventory"; if (s === "service") return "service"; return PT_DEFAULT; };
  const buildProps = (rec) => { const props = {}; for (const m of mappings) { let val = applyTransform(rec, m); if (val === undefined) continue; if (m.targetField === "hs_product_type") val = normPT(val); props[m.targetField] = val; } for (const cf of customFields) { if (!cf || !cf.customPropertyName) continue; const sf = cf.sourceField || ""; let val = sf.startsWith("__fixed:") ? sf.slice(8) : getPath(rec, sf); if (val === undefined || val === null || val === "") continue; props[sanitizeProp(cf.customPropertyName)] = val; } return props; };
  async function searchByCin7Id(pid) { try { const s = await fastn.connector.hubspot.searchProducts({ filterGroups: [{ filters: [{ propertyName: "cin7_product_id", operator: "EQ", value: String(pid) }] }], sorts: [], query: "", properties: ["cin7_product_id"], limit: 1, after: "0" }); return s?.output?.results?.[0]?.id || null; } catch (e) { return null; } }
  async function searchBySku(sku) { if (!sku) return null; try { const s = await fastn.connector.hubspot.searchProducts({ filterGroups: [{ filters: [{ propertyName: "hs_sku", operator: "EQ", value: String(sku) }] }], sorts: [], query: "", properties: ["hs_sku"], limit: 1, after: "0" }); return s?.output?.results?.[0]?.id || null; } catch (e) { return null; } }

  async function syncProduct(p) {
    if (String(p.Status) === "Deprecated") { let tid = await searchByCin7Id(p.ID) || await searchBySku(p.SKU) || await fastn.state.get(IDMAP(p.ID)); if (tid) { try { await fastn.connector.hubspot.archiveProduct({ productId: String(tid) }); result.archived = (result.archived || 0) + 1; } catch (e) { result.errors++; } await fastn.state.delete(IDMAP(p.ID)).catch(() => { }); await fastn.state.delete(HASH(p.ID)).catch(() => { }); } else { result.skipped++; } return; }
    if (!evalConditions(p)) { result.skipped++; return; }
    const props = buildProps(p); const hashVal = JSON.stringify(props);
    const prior = await fastn.state.get(HASH(p.ID)); let targetId = await fastn.state.get(IDMAP(p.ID));
    if (targetId && prior === hashVal) { const f = await searchByCin7Id(p.ID); if (f) { result.skipped++; return; } targetId = null; }
    Object.keys(props).forEach(k => { if (props[k] == null) delete props[k]; });
    if (!targetId) targetId = await searchByCin7Id(p.ID) || await searchBySku(props.hs_sku);
    if (targetId) { try { await fastn.connector.hubspot.updateProduct({ productId: targetId, properties: props }); result.updated++; } catch (e) { const f = await searchByCin7Id(p.ID) || await searchBySku(props.hs_sku); if (f) { await fastn.connector.hubspot.updateProduct({ productId: f, properties: props }); targetId = f; result.updated++; } else { const c = await fastn.connector.hubspot.createProduct({ properties: props }); targetId = c.output?.id; result.created++; } } }
    else { try { const c = await fastn.connector.hubspot.createProduct({ properties: props }); targetId = c.output?.id; result.created++; } catch (e) { const f = await searchByCin7Id(p.ID) || await searchBySku(props.hs_sku); if (f) { await fastn.connector.hubspot.updateProduct({ productId: f, properties: props }); targetId = f; result.updated++; } else throw e; } }
    if (targetId) { await fastn.state.set(IDMAP(p.ID), String(targetId)); await fastn.state.set(HASH(p.ID), hashVal); }
  }

  const seen = new Set();
  const fetchOne = async (params) => { try { const r = await fastn.connector.cin7core.listProducts({ ...params, Limit: 1, IncludeDeprecated: true }); return r.output?.Products?.[0] || null; } catch (e) { return null; } };
  for (const id of pids) { try { const p = await fetchOne({ ID: id }); if (!p) { result.skipped++; continue; } if (seen.has(p.ID)) continue; seen.add(p.ID); await syncProduct(p); result.details.push({ productId: id, sku: p.SKU }); } catch (e) { result.errors++; result.details.push({ productId: id, reason: "sync failed", errorMessage: String(e).slice(0, 150) }); } }
  for (const sku of skus) { try { const p = await fetchOne({ Sku: sku }); if (!p) { result.skipped++; continue; } if (seen.has(p.ID)) continue; seen.add(p.ID); await syncProduct(p); result.details.push({ sku, productId: p.ID }); } catch (e) { result.errors++; result.details.push({ sku, reason: "sync failed", errorMessage: String(e).slice(0, 150) }); } }
  return result;
}