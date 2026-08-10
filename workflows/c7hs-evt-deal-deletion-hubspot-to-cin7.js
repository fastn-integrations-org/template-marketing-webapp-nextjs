export default async function (ctx) {
  // HubSpot deal deleted -> reflect in the mapped Cin7 sale.
  // REALITY: Cin7 only voids AUTHORISED sales. Unauthorised drafts (ORDERING/ESTIMATED/QUOTE) cannot be
  // voided OR deleted via the API (verified). So: void when authorised; otherwise flag the sale (best effort)
  // and report honestly. Never silently claim a void that didn't happen.
  // Installation-aware: ambient fastn routes cin7core through the installation's connection.
  const IDMAP = (id) => `c7hs:idmap:deal:h2c:${id}`;
  const HASH = (id) => `c7hs:hash:deal:h2c:${id}`;
  const VOIDABLE = new Set(["AUTHORISED","AUTHORIZED","INVOICED","FULFILLED","COMPLETED","PARTIALLY INVOICED","PARTIALLY FULFILLED","PAID","PARTIALLY PAID","BACKORDERED","ORDERED","PARTIALLY SHIPPED","SHIPPED","PICKED","PACKED"]);

  const DRAFTS = new Set(["DRAFT","ORDERING","ESTIMATING","ESTIMATED","QUOTE"]);
  const getStatus = async (id) => { try { const r = await fastn.connector.cin7core.getSale({ ID: String(id) }); return String(r.output?.Status || "").toUpperCase(); } catch (_) { return null; } };
  const authoriseOrder = async (id) => {
    const ord = (await fastn.connector.cin7core.getSaleOrder({ SaleID: String(id) })).output || {};
    const lines = (ord.Lines || []).map(l => ({
      ProductID: l.ProductID, SKU: l.SKU, Name: l.Name, Quantity: l.Quantity,
      Price: l.Price, Discount: l.Discount || 0, Tax: l.Tax || 0, TaxRule: l.TaxRule,
      Comment: l.Comment || "", DropShip: !!l.DropShip, BackorderQuantity: l.BackorderQuantity || 0, Total: l.Total
    }));
    await fastn.connector.cin7core.createSaleOrder({ SaleID: String(id), Status: "AUTHORISED", Memo: ord.Memo || "", Lines: lines, AdditionalCharges: ord.AdditionalCharges || [] });
    return await getStatus(id);
  };
  // Void permanently via the connector action (Void:true). Cin7's DELETE /sale takes Void as a query
  // param; the connector forwards it. VERIFIED: a raw DELETE /sale?ID=..&Void=true transitions
  // ORDERED -> VOIDED. We void then confirm Status==VOIDED. If it only un-authorised to a draft,
  // re-authorise and void once more (covers Cin7's two-step behavior on some sale states).
  // voidSaleQuery sends Void as a QUERY param (?ID=..&Void=true) which Cin7 actually honours to reach VOIDED.
  // The built-in voidSale put Void in the BODY, which Cin7 ignores (only un-authorises) — that was the bug.
  const voidOnce = async (id) => { try { await fastn.connector.cin7core.voidSaleQuery({ ID: String(id), Void: "true" }); return null; } catch (e) { return String(e).slice(0,180); } };
  const voidFully = async (id) => {
    let err = await voidOnce(id);
    let st = await getStatus(id);
    if (st === "VOIDED") return { ok: true, status: st };
    if (DRAFTS.has(st)) {
      let ast; try { ast = await authoriseOrder(id); } catch (e) { return { ok: false, status: st, error: "reauthorise failed: " + String(e).slice(0,150) }; }
      if (DRAFTS.has(String(ast))) return { ok: false, status: ast, error: "still draft after re-authorise" };
      err = await voidOnce(id);
      st = await getStatus(id);
    }
    return { ok: st === "VOIDED", status: st, error: st === "VOIDED" ? undefined : (err || "void did not reach VOIDED") };
  };

  const events = Array.isArray(ctx.input) ? ctx.input : (ctx.input ? [ctx.input] : []);
  const result = { voided: 0, flagged: 0, skipped: 0, errors: 0, details: [] };
  if (events.length === 0) return { ...result, reason: "no events in payload" };

  for (const e of events) {
    const objectId = e && (e.objectId ?? e.objectID ?? e.id);
    try {
      const subType = String((e && (e.subscriptionType || e.eventType)) || "").toLowerCase();
      if (subType && !subType.includes("delet")) { result.skipped++; result.details.push({ objectId, reason: "non-deletion event ignored", subType }); continue; }
      if (!objectId) { result.skipped++; result.details.push({ reason: "event had no objectId" }); continue; }

      const saleId = await fastn.state.get(IDMAP(objectId));
      if (!saleId) { result.skipped++; result.details.push({ objectId, reason: "no Cin7 sale mapping (never synced)" }); continue; }

      let sale = null;
      try { const r = await fastn.connector.cin7core.getSale({ ID: String(saleId) }); sale = r.output || null; } catch (e2) { sale = null; }
      if (!sale) {
        await fastn.state.delete(IDMAP(objectId)).catch(() => {});
        await fastn.state.delete(HASH(objectId)).catch(() => {});
        result.skipped++; result.details.push({ objectId, saleId, reason: "Cin7 sale not found; cleared mapping" });
        continue;
      }
      const status = String(sale.Status || "").toUpperCase();
      if (status === "VOIDED") {
        await fastn.state.delete(IDMAP(objectId)).catch(() => {});
        await fastn.state.delete(HASH(objectId)).catch(() => {});
        result.skipped++; result.details.push({ objectId, saleId, reason: "already VOIDED; cleared mapping" });
        continue;
      }

      if (VOIDABLE.has(status)) {
        // Authorised/post-auth sale -> void (handles Cin7's un-authorise-then-void two-step) and VERIFY.
        const vr = await voidFully(saleId);
        if (vr.ok) {
          result.voided++; result.details.push({ objectId, saleId, action: "voided", priorStatus: status });
          await fastn.state.delete(IDMAP(objectId)).catch(() => {});
          await fastn.state.delete(HASH(objectId)).catch(() => {});
        } else {
          result.errors++; result.details.push({ objectId, saleId, reason: "void not confirmed VOIDED", statusAfter: vr.status, errorMessage: vr.error });
        }
      } else {
        // Unauthorised draft (ORDERING/ESTIMATED/QUOTE). Cin7 won't void a draft directly.
        // Per user choice: AUTHORISE the order first (so the sale becomes voidable), then VOID it.
        // NOTE: authorising momentarily commits the order (inventory/financial movement) before the void.
        // Every step is verified; on any failure we fall back to flagging the Note so nothing is silently wrong.
        let authorised = false, authErr = null;
        try {
          const ast = await authoriseOrder(saleId);
          authorised = !!ast && !DRAFTS.has(String(ast));
        } catch (e2) { authErr = String(e2).slice(0, 200); }

        if (authorised) {
          // Now a real void is possible (helper handles the un-authorise-then-void two-step). VERIFY.
          const vr = await voidFully(saleId);
          if (vr.ok) {
            result.voided++;
            result.details.push({ objectId, saleId, action: "authorised-then-voided", priorStatus: status });
            await fastn.state.delete(IDMAP(objectId)).catch(() => {});
            await fastn.state.delete(HASH(objectId)).catch(() => {});
          } else {
            result.errors++;
            result.details.push({ objectId, saleId, reason: "authorised but void not confirmed", statusAfter: vr.status, errorMessage: vr.error });
          }
        } else {
          // Could not authorise -> fall back to the safe flag so the draft is visibly marked for manual deletion.
          let flagged = false;
          try {
            const note = ("[HubSpot deal deleted] " + (sale.Note || "")).slice(0, 1024);
            await fastn.connector.cin7core.updateSale({ ID: String(saleId), Customer: sale.Customer, CustomerID: sale.CustomerID, Location: sale.Location || "Main Warehouse", Note: note });
            flagged = true;
          } catch (e2) { /* flagging is best-effort */ }
          result.flagged++;
          result.details.push({ objectId, saleId, status, action: flagged ? "could not authorise; flagged Note '[HubSpot deal deleted]' for manual void" : "could not authorise or flag", authoriseError: authErr });
          await fastn.state.delete(IDMAP(objectId)).catch(() => {});
          await fastn.state.delete(HASH(objectId)).catch(() => {});
        }
      }
    } catch (err) {
      result.errors++; result.details.push({ objectId, reason: "deal deletion handler failed", errorMessage: String(err).slice(0, 200) });
    }
  }
  return result;
}