export default async function (ctx) {
  // HubSpot delivers webhook events as an ARRAY of notification objects (batched).
  // Cin7 Core delivers a SINGLE JSON object with an EventType field (e.g. "Sale/Created").
  const raw = ctx.input;
  const events = Array.isArray(raw) ? raw
    : Array.isArray(raw?.events) ? raw.events
    : Array.isArray(raw?.body) ? raw.body
    : (raw && typeof raw === "object") ? [raw]
    : [];

  // Group unique record ids per event type, e.g. { "company.creation": [123], "Sale/Created": ["abc"] }
  const grouped = {};
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    const type = typeof e.subscriptionType === "string" ? e.subscriptionType
      : typeof e.EventType === "string" ? e.EventType
      : "unknown";
    const id = e.objectId ?? e.SaleID ?? e.CustomerID ?? e.ProductID ?? e.PurchaseID ?? e.LeadID ?? e.OpportunityID ?? e.TaskID ?? e.SKU ?? null;
    if (id == null && type === "unknown") continue;
    (grouped[type] = grouped[type] || new Set()).add(id != null ? id : "(no id)");
  }
  const result = Object.fromEntries(
    Object.entries(grouped).map(([t, ids]) => [t, [...ids]])
  );

  console.log("Hello World");
  for (const [type, ids] of Object.entries(result)) {
    console.log(`${type}:`, ids.join(", "));
  }
  console.log("payload:", JSON.stringify(events).slice(0, 2000));

  return {
    message: "Hello World",
    eventsReceived: Object.values(result).reduce((n, ids) => n + ids.length, 0),
    events: result,
    payload: events,
    errors: 0
  };
}