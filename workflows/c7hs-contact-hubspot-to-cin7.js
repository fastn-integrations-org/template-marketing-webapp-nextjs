export default async function (ctx) {
  const TEMPLATE_ID = "cfg_0a958721d430"; // getByTemplate resolves the installation's clone
  const CURSOR_KEY = "c7hs:cursor:contact:hubspot-to-cin7";
  const IDMAP = (key) => `c7hs:idmap:contact:h2c:${key}`;
  const HASH = (key) => `c7hs:hash:contact:h2c:${key}`;
  const CIDMAP = (hsId) => `c7hs:idmap:contacthsid:h2c:${hsId}`;
  const COMPANY_RECONCILER = "c7hs-company-hubspot-to-cin7";

  // Ambient `fastn` global for connectors/state/config AND fastn.flow.invokeAsync — all installation-scoped.
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

  // Canonical orientation: the Contact entity is stored source=cin7core, target=hubspot.
  const dir = flows.find(d =>
    (d.source?.entity ?? d.sourceEntity) === "contact" && (d.source?.connector ?? d.sourceConnector) === "cin7core" &&
    (d.target?.entity ?? d.targetEntity) === "contact" && (d.target?.connector ?? d.targetConnector) === "hubspot");
  if (!dir) return { error: "contact entity not found in config", created:0, updated:0, skipped:0, rolledUp:0, errors:0, errorDetails:[] };
  const mappings = dir.mappings || [];
  const conditions = dir.conditions || [];

  const cd = config.cin7Defaults || {};
  const DEF = {
    Status: "Active",
    Currency: cd.baseCurrency || "USD",
    PaymentTerm: cd.paymentTerm || "Net 30",
    TaxRule: cd.taxRule || "GST Standard Rate",
    AccountReceivable: cd.accountReceivable || "_1150040027_",
    RevenueAccount: cd.revenueAccount || "_26_",
    PriceTier: cd.priceTier || "Tier 1"
  };
  const elig = (config.eligibility && config.eligibility.contact) || {};
  const included = Array.isArray(elig.included) ? elig.included : [];
  const excluded = Array.isArray(elig.excluded) ? elig.excluded : [];
  function eligible(id){ if (included.length && !included.includes(id)) return false; if (excluded.length && excluded.includes(id)) return false; return true; }

  function prop(rec, name){ return rec?.properties?.[name]; }
  function evalConditions(rec){
    for (const c of conditions){
      if (c.field === "addressType") continue;
      const v = prop(rec, c.field);
      if (v === undefined) continue; // Cin7-side condition (field absent on HubSpot record) does not apply here
      const op = c.operator; const target = c.value;
      const pass = op==="equals"?String(v)===String(target):op==="not_equals"?String(v)!==String(target)
        :op==="contains"?String(v??"").includes(target):op==="is_empty"?!v:op==="is_not_empty"?!!v
        :op==="in"?String(target).split(",").map(s=>s.trim()).includes(String(v)):op==="not_in"?!String(target).split(",").map(s=>s.trim()).includes(String(v)):true;
      if (!pass) return false;
    }
    return true;
  }
  function trimName(first, last){ return [first, last].map(x=>(x==null?"":String(x).trim())).filter(Boolean).join(" ").trim(); }

  async function associatedCompanyId(contactId){
    try {
      const a = await fastn.connector.hubspot.listAssociations({ fromObjectType:"contacts", fromObjectId:String(contactId), toObjectType:"companies", limit:5 });
      const ids = (a.output?.results||[]).map(x=>x.toObjectId).filter(Boolean);
      return ids.length ? String(ids[0]) : null;
    } catch(e){ return null; }
  }

  const result = { created:0, updated:0, skipped:0, skippedNoCompany:0, rolledUp:0, errors:0, errorDetails:[] };
  const companiesToNudge = new Set();
  const cursorIso = isManual ? (input.modifiedSince || null) : (await fastn.state.get(CURSOR_KEY) || null);
  let newCursorMax = cursorIso;
  let after = "0";
  let pages = 0;

  while (pages < maxPages) {
    const sr = { filterGroups: [], sorts: [{ propertyName: "lastmodifieddate", direction: "ASCENDING" }], query: "", properties: ["email","firstname","lastname","phone","company","lastmodifieddate"], limit, after };
    if (cursorIso) sr.filterGroups = [{ filters: [{ propertyName: "lastmodifieddate", operator: "GT", value: String(new Date(cursorIso).getTime()) }] }];
    let resp;
    try { resp = await fastn.connector.hubspot.searchContacts(sr); }
    catch(e){ result.errors++; result.errorDetails.push({ reason:"searchContacts failed", errorMessage:String(e).slice(0,200) }); break; }
    const contacts = resp.output?.results || [];
    if (contacts.length === 0) break;

    for (const ct of contacts) {
      try {
        const lm = prop(ct, "lastmodifieddate");
        if (lm && (!newCursorMax || new Date(lm) > new Date(newCursorMax))) newCursorMax = lm;
        if (!eligible(ct.id)) { result.skipped++; continue; }
        if (!evalConditions(ct)) { result.skipped++; continue; }

        const compId = await associatedCompanyId(ct.id);
        if (compId) {
          companiesToNudge.add(compId);
          result.rolledUp++;
          continue;
        }

        result.skippedNoCompany++;
        result.skipped++;
        continue;
      } catch(e) {
        result.errors++; result.errorDetails.push({ sourceId: ct.id, reason:"sync failed", errorMessage:String(e).slice(0,200) });
      }
    }
    const next = resp.output?.paging?.next?.after;
    if (!next) break;
    after = next; pages++;
  }

  const nudged = [];
  for (const compId of companiesToNudge) {
    try {
      const r = await fastn.flow.invokeAsync(COMPANY_RECONCILER, { companyId: compId });
      nudged.push({ companyId: compId, executionId: r && r.executionId });
    } catch(e) {
      result.errors++; result.errorDetails.push({ companyId: compId, reason:"company nudge failed", errorMessage:String(e).slice(0,200) });
    }
  }

  if (!isManual && newCursorMax) await fastn.state.set(CURSOR_KEY, newCursorMax);
  return { ...result, companiesNudged: nudged };
}