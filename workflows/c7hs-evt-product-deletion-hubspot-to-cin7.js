export default async function (ctx) {
  // Soft-delete (deprecate) the Cin7 product mapped to a deleted HubSpot product.
  // Cin7 has no product hard-delete, and a record with transaction history can't be removed,
  // so deletion == Status 'Deprecated'. State keys are cleared so a future re-create starts clean.
  // Installation-aware: ambient fastn routes cin7core through the installation's connection.
  const IDMAP = (id) => `c7hs:idmap:product:h2c:${id}`;
  const HASH = (id) => `c7hs:hash:product:h2c:${id}`;

  const events = Array.isArray(ctx.input) ? ctx.input : (ctx.input ? [ctx.input] : []);
  const result = { deprecated: 0, skipped: 0, errors: 0, details: [] };
  if (events.length === 0) return { ...result, reason: "no events in payload" };

  for (const e of events) {
    const objectId = e && (e.objectId ?? e.objectID ?? e.id);
    try {
      // Defensive: this workflow is bound to product.deletion, but ignore anything that isn't a deletion
      const subType = String((e && (e.subscriptionType || e.eventType)) || "").toLowerCase();
      if (subType && !subType.includes("delet")) { result.skipped++; result.details.push({ objectId, reason: "non-deletion event ignored", subType }); continue; }
      if (!objectId) { result.skipped++; result.details.push({ reason: "event had no objectId" }); continue; }

      const cin7Id = await fastn.state.get(IDMAP(objectId));
      if (!cin7Id) { result.skipped++; result.details.push({ objectId, reason: "no Cin7 mapping (never synced)" }); continue; }

      // Read the current Cin7 product so the update carries the full required field set
      let existing = null;
      try {
        const ex = await fastn.connector.cin7core.listProducts({ ID: String(cin7Id), Limit: 1, IncludeDeprecated: true });
        existing = ex.output?.Products?.[0] || null;
      } catch (e2) { existing = null; }

      if (!existing) {
        await fastn.state.delete(IDMAP(objectId)).catch(() => {});
        await fastn.state.delete(HASH(objectId)).catch(() => {});
        result.skipped++; result.details.push({ objectId, cin7Id, reason: "Cin7 product not found; cleared stale mapping" });
        continue;
      }

      if (String(existing.Status) === "Deprecated") {
        await fastn.state.delete(IDMAP(objectId)).catch(() => {});
        await fastn.state.delete(HASH(objectId)).catch(() => {});
        result.skipped++; result.details.push({ objectId, cin7Id, sku: existing.SKU, reason: "already Deprecated; cleared mapping" });
        continue;
      }

      const tiers = {};
      for (let i = 1; i <= 10; i++) tiers["PriceTier" + i] = existing["PriceTier" + i] != null ? existing["PriceTier" + i] : 0;
      const body = {
        ID: String(cin7Id),
        SKU: existing.SKU,
        Name: existing.Name,
        Category: existing.Category,
        CostingMethod: existing.CostingMethod || "FIFO",
        UOM: existing.UOM || "Item",
        Status: "Deprecated",
        ...tiers
      };

      await fastn.connector.cin7core.updateProduct(body);
      result.deprecated++;
      result.details.push({ objectId, cin7Id, sku: existing.SKU, action: "deprecated" });

      // clear sync state so a later re-create is treated as fresh
      await fastn.state.delete(IDMAP(objectId)).catch(() => {});
      await fastn.state.delete(HASH(objectId)).catch(() => {});
    } catch (err) {
      result.errors++; result.details.push({ objectId, reason: "deprecate failed", errorMessage: String(err).slice(0, 200) });
    }
  }
  return result;
}