export default async function (ctx) {
  // Resolve a deleted HubSpot contact to its Cin7 customer via the contact-id secondary index, then:
  //  - if it was the customer's ONLY contact -> deprecate the customer (reversible mirror of company delete)
  //  - if the customer has OTHER contacts -> drop just this contact, keep the customer Active.
  // Cin7 has no contact/customer hard-delete.
  // Installation-aware: ambient fastn routes cin7core through the installation's connection.
  const CIDMAP = (hsId) => `c7hs:idmap:contacthsid:h2c:${hsId}`;
  const IDMAP = (key) => `c7hs:idmap:contact:h2c:${key}`;
  const HASH = (key) => `c7hs:hash:contact:h2c:${key}`;
  const DEF = { Currency: "USD", PaymentTerm: "30 days", TaxRule: "Auto Look Up", AccountReceivable: "1200", RevenueAccount: "4000", PriceTier: "Tier 1" };

  const events = Array.isArray(ctx.input) ? ctx.input : (ctx.input ? [ctx.input] : []);
  const result = { deprecated: 0, contactRemoved: 0, skipped: 0, errors: 0, details: [] };
  if (events.length === 0) return { ...result, reason: "no events in payload" };

  const norm = (s) => String(s || "").trim().toLowerCase();

  for (const e of events) {
    const objectId = e && (e.objectId ?? e.objectID ?? e.id);
    try {
      const subType = String((e && (e.subscriptionType || e.eventType)) || "").toLowerCase();
      if (subType && !subType.includes("delet")) { result.skipped++; result.details.push({ objectId, reason: "non-deletion event ignored", subType }); continue; }
      if (!objectId) { result.skipped++; result.details.push({ reason: "event had no objectId" }); continue; }

      const raw = await fastn.state.get(CIDMAP(objectId));
      if (!raw) { result.skipped++; result.details.push({ objectId, reason: "no contact-id mapping (synced before deletion support, or never synced)" }); continue; }
      let meta; try { meta = JSON.parse(raw); } catch { meta = { customerId: raw }; }
      const custId = meta.customerId;
      const delEmail = norm(meta.email);
      const delName = norm(meta.name);
      // TOMBSTONE: mark this contact deleted for 15 min so no sync re-creates it on either side.
      if (delEmail) await fastn.state.set(`c7hs:tombstone:contact:${delEmail}`, new Date().toISOString()).catch(()=>{});

      const clearState = async () => {
        await fastn.state.delete(CIDMAP(objectId)).catch(() => {});
        if (meta.dedupeKey) { await fastn.state.delete(IDMAP(meta.dedupeKey)).catch(() => {}); await fastn.state.delete(HASH(meta.dedupeKey)).catch(() => {}); }
      };

      if (!custId) { await clearState(); result.skipped++; result.details.push({ objectId, reason: "mapping had no customerId; cleared" }); continue; }

      let existing = null;
      try {
        const ex = await fastn.connector.cin7core.listCustomers({ ID: String(custId), Limit: 1, IncludeDeprecated: true });
        existing = ex.output?.CustomerList?.[0] || null;
      } catch (e2) { existing = null; }

      if (!existing) { await clearState(); result.skipped++; result.details.push({ objectId, custId, reason: "Cin7 customer not found; cleared mapping" }); continue; }

      const contacts = Array.isArray(existing.Contacts) ? existing.Contacts : [];
      const remaining = contacts.filter(c => {
        const ce = norm(c.Email), cn = norm(c.Name);
        if (delEmail && ce) return ce !== delEmail;   // prefer email match
        if (delName && cn) return cn !== delName;      // fall back to name
        return true;                                    // can't identify -> keep
      });

      // ORIGIN GUARD: if the contact is already absent from the Cin7 customer, the deletion
      // originated on the Cin7 side (our sweep archived the HubSpot contact). Nothing to change
      // in Cin7 — and definitely do NOT deprecate the customer. Just clear the mappings.
      if (remaining.length === contacts.length) {
        await clearState();
        result.skipped++;
        result.details.push({ objectId, custId, name: existing.Name, reason: "contact already absent in Cin7 (deletion originated in Cin7); customer left untouched" });
        continue;
      }

      const base = {
        ID: String(custId),
        Name: existing.Name,
        Currency: existing.Currency || DEF.Currency,
        PaymentTerm: existing.PaymentTerm || DEF.PaymentTerm,
        TaxRule: existing.TaxRule || DEF.TaxRule,
        AccountReceivable: existing.AccountReceivable || DEF.AccountReceivable,
        RevenueAccount: existing.RevenueAccount || DEF.RevenueAccount,
        PriceTier: existing.PriceTier || DEF.PriceTier
      };
      const mapContacts = (arr) => arr.map(c => ({ Name: c.Name || "", Email: c.Email || "", Phone: c.Phone || "", Default: !!c.Default, IncludeInEmail: !!c.IncludeInEmail }));

      // Cin7 cannot remove a customer's LAST contact (empty Contacts[] is ignored by the API). So:
      //  - other contacts remain -> write the reduced list (that removal works)
      //  - it was the sole contact -> deprecate the whole customer (per chosen policy)
      if (remaining.length === 0) {
        if (String(existing.Status) === "Deprecated") {
          await clearState(); result.skipped++; result.details.push({ objectId, custId, name: existing.Name, reason: "already Deprecated; cleared mapping" }); continue;
        }
        await fastn.connector.cin7core.updateCustomerFull({ body: JSON.stringify({ ...base, Status: "Deprecated", Contacts: mapContacts(contacts) }) });
        result.deprecated++;
        result.details.push({ objectId, custId, name: existing.Name, action: "customer deprecated (was sole contact; Cin7 can't remove the last contact)" });
      } else {
        await fastn.connector.cin7core.updateCustomerFull({ body: JSON.stringify({ ...base, Status: existing.Status || "Active", Contacts: mapContacts(remaining) }) });
        result.contactRemoved++;
        result.details.push({ objectId, custId, name: existing.Name, action: "contact removed; customer kept active", remainingContacts: remaining.length });
      }
      await clearState();
    } catch (err) {
      result.errors++; result.details.push({ objectId, reason: "contact deletion failed", errorMessage: String(err).slice(0, 200) });
    }
  }
  return result;
}