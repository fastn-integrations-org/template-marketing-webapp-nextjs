export default async function (ctx) {
  // Installation-aware: resolve the per-installation config clone from the widget
  // template, and use the AMBIENT fastn so connector calls route through the
  // installation's connections (no hardcoded pool/pinned connections).
  const TEMPLATE_ID = "cfg_0a958721d430";
  const DEALMAP = (id) => `c7hs:idmap:deal:h2c:${id}`;

  // Read the dealstage->status map from config EVERY run (single source of truth = the widget UI).
  let stageToStatus = {};
  try {
    const cfg = (await fastn.config.getByTemplate(TEMPLATE_ID).catch(() => null)) || (await fastn.config.get(TEMPLATE_ID));
    const ent = (cfg.entities || cfg.directions || []).find(d =>
      (d.source?.entity ?? d.sourceEntity) === "dealstage" && (d.target?.entity ?? d.targetEntity) === "status");
    for (const m of (ent?.mappings || [])) {
      const stage = String(m.sourceField || "").trim();
      const status = String(m.targetField || "").trim().toUpperCase();
      if (stage) stageToStatus[stage.toLowerCase()] = status;
    }
  } catch (e) {}

  // Translate a configured target Cin7 status to the achievable Cin7 action.
  function actionForStatus(status) {
    const s = String(status || "").toUpperCase();
    if (["AUTHORISED","AUTHORIZED","ORDERED","BACKORDERED","INVOICED","INVOICING","COMPLETED","PAID"].includes(s)) return "authorise";
    if (["VOIDED","CREDITED","CANCELLED","CANCELED"].includes(s)) return "flag";
    return "none"; // DRAFT / ORDERING / ESTIMATING / ESTIMATED / NOT AVAILABLE / blank / unmapped
  }

  const EDITABLE_DRAFT = new Set(["ORDERING","ESTIMATED","ESTIMATING","DRAFT"]);

  // Voiding (mirrors wf_7dc6378bfc3f, the proven deal-deletion void logic).
  // voidSaleQuery sends Void as a QUERY param (?ID=..&Void=true) which Cin7 honours to reach VOIDED;
  // the built-in voidSale puts Void in the BODY, which Cin7 ignores (it only un-authorises).
  const VOIDABLE = new Set(["AUTHORISED","AUTHORIZED","INVOICED","FULFILLED","COMPLETED","PARTIALLY INVOICED","PARTIALLY FULFILLED","PAID","PARTIALLY PAID","BACKORDERED","ORDERED","PARTIALLY SHIPPED","SHIPPED","PICKED","PACKED"]);
  const DRAFTS = new Set(["DRAFT","ORDERING","ESTIMATING","ESTIMATED","QUOTE"]);
  const getStatus = async (id) => { try { const r = await fastn.connector.cin7core.getSale({ ID: String(id) }); return String(r.output?.Status || "").toUpperCase(); } catch (_) { return null; } };
  const reauthoriseOrder = async (id) => {
    const ord = (await fastn.connector.cin7core.getSaleOrder({ SaleID: String(id) })).output || {};
    const ls = (ord.Lines || []).map(l => ({ ProductID: l.ProductID, SKU: l.SKU, Name: l.Name, Quantity: l.Quantity, Price: l.Price, Discount: l.Discount || 0, Tax: l.Tax || 0, TaxRule: l.TaxRule, Comment: l.Comment || "", DropShip: !!l.DropShip, BackorderQuantity: l.BackorderQuantity || 0, Total: l.Total }));
    await fastn.connector.cin7core.createSaleOrder({ SaleID: String(id), Status: "AUTHORISED", Memo: ord.Memo || "", Lines: ls, AdditionalCharges: ord.AdditionalCharges || [] });
    return await getStatus(id);
  };
  const voidOnce = async (id) => { try { await fastn.connector.cin7core.voidSaleQuery({ ID: String(id), Void: "true" }); return null; } catch (e) { return String(e).slice(0,180); } };
  const voidFully = async (id) => {
    let err = await voidOnce(id);
    let st = await getStatus(id);
    if (st === "VOIDED") return { ok: true, status: st };
    if (DRAFTS.has(st)) {
      let ast; try { ast = await reauthoriseOrder(id); } catch (e) { return { ok: false, status: st, error: "reauthorise failed: " + String(e).slice(0,150) }; }
      if (DRAFTS.has(String(ast))) return { ok: false, status: ast, error: "still draft after re-authorise" };
      err = await voidOnce(id);
      st = await getStatus(id);
    }
    return { ok: st === "VOIDED", status: st, error: st === "VOIDED" ? undefined : (err || "void did not reach VOIDED") };
  };

  const input = ctx.input || {};
  const dealIds = (input.dealId != null ? [String(input.dealId)] : [])
    .concat(Array.isArray(input.dealIds) ? input.dealIds.map(String) : []);
  const result = { authorised: 0, voided: 0, flagged: 0, noop: 0, skipped: 0, errors: 0, configMap: stageToStatus, details: [] };
  if (dealIds.length === 0) return { ...result, reason: "no dealId provided" };

  // HubSpot delivers duplicate notifications — process each deal once.
  const uniqueDealIds = [...new Set(dealIds.map(String))];
  for (const dealId of uniqueDealIds) {
    try {
      const d = await fastn.connector.hubspot.getDeal({ dealId, properties: ["dealname","dealstage"] }).catch(()=>null);
      const stage = d?.output?.properties?.dealstage;
      if (!stage) { result.skipped++; result.details.push({ dealId, reason: "deal not found / no stage" }); continue; }

      const targetStatus = stageToStatus[String(stage).toLowerCase()] || null;
      const action = actionForStatus(targetStatus);  // 100% from config, no override

      let saleId = await fastn.state.get(DEALMAP(dealId));
      // CREATION-RACE RETRY: on deal creation this workflow runs in parallel with the sale
      // reconciler, so the idmap may not exist yet. Wait up to ~20s before giving up, so the
      // deal's initial stage is applied to the freshly created sale.
      for (let w = 0; !saleId && action !== "none" && w < 4; w++) {
        { const _s = Date.now(); while (Date.now() - _s < 5000) {} }
        saleId = await fastn.state.get(DEALMAP(dealId));
      }
      if (!saleId) { result.skipped++; result.details.push({ dealId, stage, targetStatus, action, reason: "no mapped Cin7 sale (after retry wait)" }); continue; }

      const sale = (await fastn.connector.cin7core.getSale({ ID: String(saleId) }).catch(()=>({}))).output;
      if (!sale) { result.skipped++; result.details.push({ dealId, stage, saleId, reason: "Cin7 sale not found" }); continue; }
      const status = String(sale.Status || "").toUpperCase();

      if (action === "none") { result.noop++; result.details.push({ dealId, stage, targetStatus, saleId, status, action: "no lifecycle change for this configured target status" }); continue; }

      if (action === "authorise") {
        if (!EDITABLE_DRAFT.has(status)) { result.skipped++; result.details.push({ dealId, stage, targetStatus, saleId, status, reason: "sale already authorised/finalised; left as-is" }); continue; }
        const lines = (sale.Order?.Lines || []).map(l => ({ ProductID: l.ProductID, SKU: l.SKU, Name: l.Name, Quantity: l.Quantity, Price: l.Price, Discount: l.Discount || 0, Tax: l.Tax || 0, Total: l.Total, TaxRule: l.TaxRule || sale.TaxRule || "GST Standard Rate" }));
        if (lines.length === 0) { result.skipped++; result.details.push({ dealId, stage, targetStatus, saleId, status, reason: "cannot authorise — sale has no order lines" }); continue; }
        try {
          await fastn.connector.cin7core.createSaleOrder({ SaleID: String(saleId), Status: "AUTHORISED", Lines: lines });
          const after = String((await fastn.connector.cin7core.getSale({ ID: String(saleId) })).output?.Order?.Status || "").toUpperCase();
          if (after === "AUTHORISED") { result.authorised++; result.details.push({ dealId, stage, targetStatus, saleId, priorStatus: status, action: "order AUTHORISED" }); }
          else { result.errors++; result.details.push({ dealId, stage, targetStatus, saleId, reason: "authorise returned but order not AUTHORISED", orderStatusAfter: after }); }
        } catch (e) { result.errors++; result.details.push({ dealId, stage, targetStatus, saleId, reason: "authorise failed", errorMessage: String(e).slice(0,200) }); }
        continue;
      }

      if (action === "flag") {
        if (status === "VOIDED") { result.noop++; result.details.push({ dealId, stage, targetStatus, saleId, status, action: "already VOIDED" }); continue; }
        // Drafts included: voidFully() authorises an unauthorised draft first, then voids and
        // verifies — so a VOIDED target now actually lands instead of only flagging the Note.
        if (VOIDABLE.has(status) || DRAFTS.has(status)) {
          // Sale is authorised/post-auth -> actually VOID it (query-param void, then VERIFY via getSale).
          const vr = await voidFully(saleId);
          if (vr.ok) { result.voided++; result.details.push({ dealId, stage, targetStatus, saleId, priorStatus: status, action: "sale VOIDED (verified via getSale)" }); }
          else { result.errors++; result.details.push({ dealId, stage, targetStatus, saleId, priorStatus: status, reason: "void not confirmed VOIDED", statusAfter: vr.status, errorMessage: vr.error }); }
          continue;
        }
        // Unauthorised draft (ORDERING/ESTIMATING/ESTIMATED/DRAFT): Cin7 cannot void a draft -> flag the Note.
        try {
          const note = (`[Deal stage '${stage}' -> ${targetStatus} in HubSpot] ` + (sale.Note || "")).slice(0, 1024);
          await fastn.connector.cin7core.updateSale({ ID: String(saleId), Customer: sale.Customer, CustomerID: sale.CustomerID, Location: sale.Location || "Main Warehouse", Note: note });
          result.flagged++; result.details.push({ dealId, stage, targetStatus, saleId, status, action: `flagged Note (Cin7 API can't set ${targetStatus} on a draft)` });
        } catch (e) { result.errors++; result.details.push({ dealId, stage, targetStatus, saleId, reason: "flag failed", errorMessage: String(e).slice(0,200) }); }
        continue;
      }
    } catch (err) {
      result.errors++; result.details.push({ dealId, reason: "stage handler failed", errorMessage: String(err).slice(0,200) });
    }
  }
  return result;
}