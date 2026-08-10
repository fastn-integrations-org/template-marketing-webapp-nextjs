export default async function (ctx) {
  // HubSpot delivers events as an ARRAY of notification objects -> ctx.input IS that array.
  const events = Array.isArray(ctx.input) ? ctx.input : (ctx.input ? [ctx.input] : []);
  const RECONCILER = "c7hs-company-hubspot-to-cin7";
  const WINDOW_MIN = 10; // small overlap so the changed record falls inside the delta window
  const modifiedSince = new Date(Date.now() - WINDOW_MIN * 60 * 1000).toISOString();

  if (events.length === 0) {
    return { triggered: false, reason: "no events in payload", reconciler: RECONCILER };
  }

  const objectIds = events.map(e => e && e.objectId).filter(v => v != null);
  // Fire-and-forget nudge: bounded manual scope, does NOT advance the scheduled cursor.
  const res = await fastn.flow.invokeAsync(RECONCILER, { modifiedSince, limit: 50, maxPages: 2 });
  return { triggered: true, reconciler: RECONCILER, modifiedSince, eventCount: events.length, objectIds, executionId: res && res.executionId };
}