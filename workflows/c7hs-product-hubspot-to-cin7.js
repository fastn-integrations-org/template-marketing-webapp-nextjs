export default async function (ctx) {
  const TEMPLATE_ID = "cfg_0a958721d430"; // widget template; getByTemplate resolves the installation's clone
  const CURSOR_KEY = "c7hs:cursor:product:hubspot-to-cin7";
  const IDMAP = (id) => `c7hs:idmap:product:h2c:${id}`;
  const HASH = (id) => `c7hs:hash:product:h2c:${id}`;

  const input = ctx.input || {};
  const isManual = input.limit != null || input.maxPages != null || input.modifiedSince != null;
  const limit = Number(input.limit) || 100;
  const maxPages = Number(input.maxPages) || 1000;

  // Installation-aware config resolution.
  // getByTemplate resolves the installation's clone when x-installation-id is present;
  // when there is no installation (dev / direct run) it can return empty — fall back to the template via get.
  const hasEntities = (c) => c && (Array.isArray(c.entities) || Array.isArray(c.directions)) && ((c.entities || c.directions).length > 0);
  let config = {};
  try {
    if (fastn.config && typeof fastn.config.getByTemplate === "function") {
      config = (await fastn.config.getByTemplate(TEMPLATE_ID)) || {};
    }
  } catch (e) { config = {}; }
  if (!hasEntities(config)) {
    try { const t = await fastn.config.get(TEMPLATE_ID); if (hasEntities(t)) config = t; } catch (e) {}
  }
  const flows = config.entities ?? config.directions ?? [];

  // New design: ONE entity per object (Cin7 Product <-> HubSpot Product)
  const entity = flows.find(d =>
    (d.source?.entity ?? d.sourceEntity) === "product" && (d.source?.connector ?? d.sourceConnector) === "cin7core" &&
    (d.target?.entity ?? d.targetEntity) === "product" && (d.target?.connector ?? d.targetConnector) === "hubspot");
  if (!entity) return { error: "product entity not found in config", created:0, updated:0, skipped:0, errors:0, errorDetails:[] };

  // Effective HubSpot -> Cin7 field pairs for the INBOUND direction:
  //  - 'both'    : stored cin7(source)->hubspot(target); reverse => hs(target) -> cin7(source)
  //  - 'inbound' : already hs/fixed(source) -> cin7(target); keep as-is
  //  - 'outbound': skip
  // (v2 map-once configs use no syncDirection => treated as 'both'; create-only values live in defaults[] handled below.)
  const normCin7 = (f) => String(f || "").replace(/^Products\./, "");
  const rawMaps = entity.mappings || [];
  const pairs = [];
  for (const mp of rawMaps) {
    const dir = mp.syncDirection || "both";
    if (dir === "outbound") continue;
    if (dir === "both") pairs.push({ sourceField: mp.targetField, targetField: normCin7(mp.sourceField) });
    else pairs.push({ sourceField: mp.sourceField, targetField: normCin7(mp.targetField) });
  }
  // Create-only Cin7 defaults from the map-once config's defaults[] (direction hubspot->cin7)
  const cfgDefaults = {};
  for (const d of (entity.defaults || [])) {
    if (d && d.direction && d.direction !== "hubspot->cin7") continue;
    if (d && d.field != null) cfgDefaults[normCin7(d.field)] = d.value;
  }
  const conditions = entity.conditions || [];

  const BASE_HS_PROPS = ["name","price","description","hs_cost_of_goods_sold","hs_product_type","hs_object_id","hs_sku","hs_lastmodifieddate"];
  const SEARCH_PROPS = [...new Set([...BASE_HS_PROPS,
    ...pairs.map(p => p.sourceField).filter(sf => sf && !sf.startsWith("__fixed:") && sf !== "hs_object_id")])];

  const cd = config.cin7Defaults || {};
  const DEF = {
    Category: cfgDefaults.Category || cd.productCategory || "HubSpot Products",
    CostingMethod: cfgDefaults.CostingMethod || "FIFO",
    UOM: cfgDefaults.UOM || "Item",
    Status: cfgDefaults.Status || "Active",
    Type: cd.productType || "Stock"
  };
  // GL accounts for Service / Non Inventory products. Configured values are validated against
  // THIS tenant's chart of accounts; invalid/missing ones self-heal to a real ACTIVE account.
  const ACCT = { ExpenseAccount: cd.expenseAccount || null, RevenueAccount: cd.revenueAccount || null, COGSAccount: cd.cogsAccount || null };
  try {
    const coa = await fastn.connector.cin7core.listChartOfAccounts({ page: 1, limit: 500 });
    const accs = (coa.output && (coa.output.AccountsList || coa.output.Accounts || coa.output.LedgerAccounts)) || [];
    const active = (Array.isArray(accs) ? accs : []).filter(a => String(a.Status || "").toUpperCase() === "ACTIVE");
    if (active.length) {
      const byCode = new Set(active.map(a => String(a.Code)));
      const pick = (clsRe, nameRe) => {
        const list = active.filter(a => clsRe.test(String(a.Class || a.Type || "")));
        if (!list.length) return null;
        const named = nameRe ? list.find(a => nameRe.test(String(a.Name || ""))) : null;
        return String((named || list[0]).Code);
      };
      if (!ACCT.ExpenseAccount || !byCode.has(String(ACCT.ExpenseAccount))) ACCT.ExpenseAccount = pick(/EXPENSE/i, /expense/i);
      if (!ACCT.RevenueAccount || !byCode.has(String(ACCT.RevenueAccount))) ACCT.RevenueAccount = pick(/REVENUE|INCOME/i, /^sales\b|sales account/i);
      if (!ACCT.COGSAccount || !byCode.has(String(ACCT.COGSAccount))) ACCT.COGSAccount = pick(/COGS|COST OF (GOODS|SALES)/i) || pick(/EXPENSE/i, /cogs|cost of goods/i) || ACCT.ExpenseAccount;
    }
  } catch (e) {}

  // INBOUND Type follows the SAME conditional mapping the widget edits (hs_product_type rule),
  // inverted: rows are Cin7->HubSpot (sourceValue -> targetValue), so HubSpot->Cin7 matches the
  // HubSpot value against targetValue and returns sourceValue. First matching row wins.
  const typeRule = (entity.mappings || []).find(mp => mp.targetField === "hs_product_type" && mp.mappingMode === "conditional" && Array.isArray(mp.conditionRows) && mp.conditionRows.length);
  // Cin7 only accepts Type: 'Stock' | 'Service' | 'Non Inventory'. Config option values may be
  // spelled differently (e.g. 'Non-stock'), so normalize whatever the config row says.
  const normCin7Type = (t) => {
    const x = String(t||"").trim().toLowerCase();
    if (x === "stock") return "Stock";
    if (x === "service") return "Service";
    if (x.startsWith("non")) return "Non Inventory";
    return null;
  };
  function cin7TypeFromHs(v){
    const s = String(v||"").trim().toLowerCase();
    if (typeRule) {
      const row = typeRule.conditionRows.find(r => String((r && r.targetValue) ?? "").trim().toLowerCase() === s);
      if (row && row.sourceValue) { const n = normCin7Type(row.sourceValue); if (n) return n; }
    }
    // fallback for HubSpot values not present in the config rows
    if (s === "inventory" || s === "stock" || s === "non_inventory" || s === "non-inventory" || s === "noninventory" || s === "non-stock" || s === "nonstock") return "Stock";
    if (s === "service") return "Service";
    return DEF.Type;
  }

  const elig = (config.eligibility && config.eligibility.product) || {};
  const included = Array.isArray(elig.included) ? elig.included : [];
  const excluded = Array.isArray(elig.excluded) ? elig.excluded : [];
  function eligible(id){ if (included.length && !included.includes(id)) return false; if (excluded.length && excluded.includes(id)) return false; return true; }

  function prop(rec, name){ if (name === "hs_object_id") return rec.id; return rec?.properties?.[name]; }
  function evalConditions(rec){
    for (const c of conditions){
      const v = prop(rec, c.field);
      if (v === undefined) continue; // Cin7-side condition (field absent on HubSpot record) does not apply here
      const op = c.operator; const target = c.value;
      if ((target == null || target === "") && op !== "is_empty" && op !== "is_not_empty") continue;
      const pass = op==="equals"?String(v)===String(target):op==="not_equals"?String(v)!==String(target)
        :op==="contains"?String(v??"").includes(target):op==="is_empty"?!v:op==="is_not_empty"?!!v
        :op==="in"?String(target).split(",").map(s=>s.trim()).includes(String(v)):op==="not_in"?!String(target).split(",").map(s=>s.trim()).includes(String(v)):true;
      if (!pass) return false;
    }
    return true;
  }
  const num = (x) => (x==null || x==="") ? 0 : Number(x);
  // cin7core connector body template does NOT JSON-escape strings: a double quote or backslash
  // in Name/Description/Category breaks the payload -> 400 "Unable to deserialize payload. Wrong format."
  // Sanitize: backslash -> space, double quote -> single quote.
  const clean = (s) => (typeof s === "string" ? s.replace(/\\/g, " ").replace(/"/g, "'") : s);

  function mapFields(p){
    const m = {};
    for (const pr of pairs){
      const sf = pr.sourceField || "";
      let v = sf.startsWith("__fixed:") ? sf.slice(8) : prop(p, sf);
      if (v === undefined || v === null) continue;
      m[pr.targetField] = v;
    }
    if (m.SKU == null || String(m.SKU).trim() === "") m.SKU = String(p.id);
    return m;
  }

  const result = { created:0, updated:0, skipped:0, errors:0, errorDetails:[] };
  const cursorIso = isManual ? (input.modifiedSince || null) : (await fastn.state.get(CURSOR_KEY) || null);

  // ---------------------------------------------------------------------------
  // CURSOR WATERMARK SAFETY
  //
  // HubSpot returns records sorted ASCENDING by hs_lastmodifieddate, and the next run filters with
  // a STRICT `hs_lastmodifieddate GT <cursor>`. A record whose timestamp is <= the cursor is
  // therefore invisible FOREVER — it is never retried, and the run reports success while silently
  // having dropped it. (This is how HubSpot product 46792283255 / SKU 9007896 was lost: the cursor
  // was advanced from the record's own timestamp before its createProduct call ran, that call then
  // failed on Cin7's 60-calls/60s limit, and the record fell permanently below the watermark.)
  //
  // Rules enforced below:
  //   1. The cursor advances ONLY over a CONTIGUOUS PREFIX of records that fully completed —
  //      i.e. reached a terminal state (created, updated, or deliberately skipped) with all state
  //      writes done. `frozen` stops the watermark at the first record that did not.
  //   2. The cursor must stay STRICTLY BELOW the timestamp of any record still needing work, so a
  //      tie (bulk edits share a timestamp) can never skip an unfinished record past a strict GT.
  //   3. If neither the last nor the previous completed timestamp qualifies, the cursor is HELD.
  //      Re-processing is cheap and idempotent — the hash check turns already-synced records into skips.
  // ---------------------------------------------------------------------------
  let lastGoodIso = null;   // greatest hs_lastmodifieddate that completed, before any failure
  let prevGoodIso = null;   // the previous DISTINCT completed timestamp (tie fallback, see below)
  let firstBadIso = null;   // earliest hs_lastmodifieddate that did NOT complete
  let frozen = false;
  // Records arrive ascending, so tracking the previous distinct completed timestamp is enough to
  // back off when the last completed record shares its timestamp with a record that failed.
  const markDone = (lm) => {
    if (frozen || !lm) return;
    if (lm !== lastGoodIso) { prevGoodIso = lastGoodIso; lastGoodIso = lm; }
  };
  const markPending = (lm) => {
    frozen = true;
    if (lm && (!firstBadIso || new Date(lm) < new Date(firstBadIso))) firstBadIso = lm;
  };
  // Cin7 Core allows 60 API calls per 60 seconds. Once throttled, every remaining record in the
  // run fails too, so stop immediately rather than burning the rest of the backlog on doomed calls.
  // The watermark is already frozen at this point, so everything unprocessed is retried next run.
  const isRateLimit = (msg) => /calls per \d+ seconds API limit|\b429\b|rate limit/i.test(String(msg));
  let throttled = false;

  let after = "0";
  let pages = 0;

  while (pages < maxPages){
    const sr = { filterGroups: [], sorts: [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }], query: "", properties: SEARCH_PROPS, limit, after };
    if (cursorIso) sr.filterGroups = [{ filters: [{ propertyName: "hs_lastmodifieddate", operator: "GT", value: String(new Date(cursorIso).getTime()) }] }];
    let resp;
    try { resp = await fastn.connector.hubspot.searchProducts(sr); }
    catch(e){ result.errors++; frozen = true; result.errorDetails.push({ reason:"searchProducts failed", errorMessage:String(e).slice(0,200) }); break; }
    const products = resp.output?.results || [];
    if (products.length === 0) break;

    for (const p of products){
      const lm = prop(p, "hs_lastmodifieddate");
      try {
        if (!eligible(p.id)) { result.skipped++; markDone(lm); continue; }
        if (!evalConditions(p)) { result.skipped++; markDone(lm); continue; }

        const m = mapFields(p);
        const sku = String(m.SKU);
        let baseName = clean(m.Name || prop(p,"name") || ("HubSpot Product " + p.id));
        const price1 = num(m.PriceTier1 ?? prop(p,"price"));
        const avgCost = num(m.AverageCost ?? prop(p,"hs_cost_of_goods_sold"));
        const description = clean(m.Description ?? prop(p,"description"));
        const cin7Type = cin7TypeFromHs(m.Type ?? prop(p,"hs_product_type"));
        const costingMethod = m.CostingMethod || DEF.CostingMethod;
        const uom = m.UOM || DEF.UOM;
        const status = m.Status || DEF.Status;
        const category = (m.Category != null && String(m.Category).trim() !== "") ? clean(m.Category) : DEF.Category;

        const hashVal = JSON.stringify({ baseName, price1, avgCost, description, type: cin7Type, category, costingMethod, uom, status });
        const priorHash = await fastn.state.get(HASH(p.id));
        // The existence check must NOT be swallowed. Treating a failed lookup as "does not exist"
        // turns it into a blind create, which then 409s with "Specified attribute 'SKU' already
        // exists" — and under the old cursor logic that record was lost. Let it fail and retry.
        let existing = null;
        try {
          const ex = await fastn.connector.cin7core.listProducts({ Sku: sku, Limit: 1 });
          existing = ex.output?.Products?.[0] || null;
        } catch (e) {
          throw new Error("cin7core.listProducts (existence check) failed, record left for retry: " + String(e).slice(0,160));
        }
        const cin7Id = existing?.ID || await fastn.state.get(IDMAP(p.id));

        if (cin7Id && priorHash === hashVal) { result.skipped++; markDone(lm); continue; }

        if (cin7Id){
          const tiers = {}; for (let i=1;i<=10;i++) tiers["PriceTier"+i] = i===1 ? price1 : (existing?.["PriceTier"+i] != null ? existing["PriceTier"+i] : 0);
          const ubody = { ID: cin7Id, SKU: sku, Name: baseName, Category: category, Type: cin7Type, CostingMethod: costingMethod, UOM: uom, Status: status, ...tiers };
          if (description != null) ubody.Description = description;
          if (avgCost != null) ubody.AverageCost = avgCost;
          if (/service|non/i.test(String(cin7Type))) { ubody.ExpenseAccount = ACCT.ExpenseAccount; ubody.RevenueAccount = ACCT.RevenueAccount; ubody.COGSAccount = ACCT.COGSAccount; }
          await fastn.connector.cin7core.updateProduct(ubody);
          result.updated++;
          await fastn.state.set(IDMAP(p.id), String(cin7Id)); await fastn.state.set(HASH(p.id), hashVal);
          markDone(lm);
        } else {
          const body = { SKU: sku, Name: baseName, Category: category, Type: cin7Type, CostingMethod: costingMethod, UOM: uom, Status: status, PriceTier1: price1 };
          if (description != null) body.Description = description;
          if (avgCost != null) body.AverageCost = avgCost;
          if (/service|non/i.test(String(cin7Type))) { body.ExpenseAccount = ACCT.ExpenseAccount; body.RevenueAccount = ACCT.RevenueAccount; body.COGSAccount = ACCT.COGSAccount; }
          let newId;
          try { const c = await fastn.connector.cin7core.createProduct(body); newId = c.output?.Products?.[0]?.ID || c.output?.ID; result.created++; }
          catch(e){
            const msg = String(e);
            if (/Expense Account is required/i.test(msg)) {
              // Cin7 requires an Expense Account for 'Non Inventory' products, but the cin7core
              // createProduct action has no GL account fields in its input contract (they are
              // silently dropped). Until the connector supports them, fall back to Stock and report.
              body.Type = "Stock";
              const c2 = await fastn.connector.cin7core.createProduct(body);
              newId = c2.output?.Products?.[0]?.ID || c2.output?.ID;
              result.created++;
              result.errorDetails.push({ sourceId: p.id, reason: "type fallback (not an error)", errorMessage: "Config maps this HubSpot type to 'Non Inventory', but Cin7 requires an Expense Account for non-inventory products and the cin7core createProduct action cannot send GL account fields. Created as 'Stock' instead." });
            } else if (msg.includes("'Name' already exists") || (msg.includes("Name") && msg.includes("already exists"))){
              body.Name = baseName + " [" + sku + "]";
              const c2 = await fastn.connector.cin7core.createProduct(body); newId = c2.output?.Products?.[0]?.ID || c2.output?.ID; result.created++;
            } else throw e;
          }
          if (newId){
            await fastn.state.set(IDMAP(p.id), String(newId)); await fastn.state.set(HASH(p.id), hashVal);
            markDone(lm);
          } else {
            // Created in Cin7 but the response carried no ID, so nothing was mapped. Hold the
            // watermark: the next run finds it by SKU and completes the mapping via the update path.
            markPending(lm);
            result.errorDetails.push({ sourceId: p.id, reason: "created without id (mapping deferred)", errorMessage: "createProduct returned no ID; id_map/hash not written. Cursor held so the next run re-resolves this record by SKU." });
          }
        }
      } catch(e){
        result.errors++;
        markPending(lm);
        const msg = String(e);
        result.errorDetails.push({ sourceId: p.id, reason:"sync failed", errorMessage: msg.slice(0,200) });
        if (isRateLimit(msg)) { throttled = true; break; }
      }
    }
    if (throttled) break;
    const next = resp.output?.paging?.next?.after;
    if (!next) break;
    after = next; pages++;
  }

  // Advance only to the last fully-processed record, and never to or past a record that still
  // needs work — strict GT means an equal timestamp would exclude that record forever. On a tie
  // (the last completed record shares a timestamp with a failed one) step back to the previous
  // distinct completed timestamp so partial progress is still kept; if even that is not strictly
  // below the failure, hold the cursor where it was.
  const below = (iso) => iso && (!firstBadIso || new Date(iso) < new Date(firstBadIso));
  let candidate = below(lastGoodIso) ? lastGoodIso : (below(prevGoodIso) ? prevGoodIso : null);
  let nextCursor = null;
  if (candidate && (!cursorIso || new Date(candidate) > new Date(cursorIso))) nextCursor = candidate;
  if (!isManual && nextCursor) await fastn.state.set(CURSOR_KEY, nextCursor);

  result.cursor = {
    previous: cursorIso,
    next: nextCursor || cursorIso,
    advanced: !!nextCursor,
    heldAt: firstBadIso || null,
    throttled
  };
  if (throttled) {
    result.errorDetails.push({ reason: "run stopped early (Cin7 rate limit)", errorMessage: "Cin7 Core allows 60 calls per 60 seconds. The run stopped to avoid failing the rest of the backlog; the cursor was held so every unprocessed record is retried on the next run." });
  }
  return result;
}