export default async function (ctx) {
  // Soft-delete (deprecate) the Cin7 customer mapped to a deleted HubSpot company.
  // Cin7 has no customer hard-delete, so deletion == Status 'Deprecated'. State is cleared after.
  // Installation-aware: ambient fastn routes cin7core through the installation's connection.
  const IDMAP = (id) => `c7hs:idmap:company:h2c:${id}`;
  const HASH = (id) => `c7hs:hash:company:h2c:${id}`;
  // Fallbacks mirror the company->customer reconciler defaults; required by Cin7's customer update.
  const DEF = { Currency: "USD", PaymentTerm: "30 days", TaxRule: "Auto Look Up", AccountReceivable: "1200", RevenueAccount: "4000", PriceTier: "Tier 1" };

  const events = Array.isArray(ctx.input) ? ctx.input : (ctx.input ? [ctx.input] : []);
  const result = { deprecated: 0, skipped: 0, errors: 0, details: [] };
  if (events.length === 0) return { ...result, reason: "no events in payload" };

  for (const e of events) {
    const objectId = e && (e.objectId ?? e.objectID ?? e.id);
    try {
      const subType = String((e && (e.subscriptionType || e.eventType)) || "").toLowerCase();
      if (subType && !subType.includes("delet")) { result.skipped++; result.details.push({ objectId, reason: "non-deletion event ignored", subType }); continue; }
      if (!objectId) { result.skipped++; result.details.push({ reason: "event had no objectId" }); continue; }

      const custId = await fastn.state.get(IDMAP(objectId));
      if (!custId) { result.skipped++; result.details.push({ objectId, reason: "no Cin7 mapping (never synced)" }); continue; }

      let existing = null;
      try {
        const ex = await fastn.connector.cin7core.listCustomers({ ID: String(custId), Limit: 1, IncludeDeprecated: true });
        existing = ex.output?.CustomerList?.[0] || null;
      } catch (e2) { existing = null; }

      if (!existing) {
        await fastn.state.delete(IDMAP(objectId)).catch(() => {});
        await fastn.state.delete(HASH(objectId)).catch(() => {});
        result.skipped++; result.details.push({ objectId, custId, reason: "Cin7 customer not found; cleared stale mapping" });
        continue;
      }
      if (String(existing.Status) === "Deprecated") {
        await fastn.state.delete(IDMAP(objectId)).catch(() => {});
        await fastn.state.delete(HASH(objectId)).catch(() => {});
        result.skipped++; result.details.push({ objectId, custId, name: existing.Name, reason: "already Deprecated; cleared mapping" });
        continue;
      }

      const body = {
        ID: String(custId),
        Name: existing.Name,
        Status: "Deprecated",
        Currency: existing.Currency || DEF.Currency,
        PaymentTerm: existing.PaymentTerm || DEF.PaymentTerm,
        TaxRule: existing.TaxRule || DEF.TaxRule,
        AccountReceivable: existing.AccountReceivable || DEF.AccountReceivable,
        RevenueAccount: existing.RevenueAccount || DEF.RevenueAccount,
        PriceTier: existing.PriceTier || DEF.PriceTier
      };
      await fastn.connector.cin7core.updateCustomerFull({ body: JSON.stringify(body) });
      result.deprecated++;
      result.details.push({ objectId, custId, name: existing.Name, action: "deprecated" });

      await fastn.state.delete(IDMAP(objectId)).catch(() => {});
      await fastn.state.delete(HASH(objectId)).catch(() => {});
    } catch (err) {
      result.errors++; result.details.push({ objectId, reason: "deprecate failed", errorMessage: String(err).slice(0, 200) });
    }
  }
  return result;
}