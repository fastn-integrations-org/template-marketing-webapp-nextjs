export default async function (ctx) {
  const events = Array.isArray(ctx.input) ? ctx.input : (ctx.input ? [ctx.input] : []);
  const RECONCILER = "c7hs-product-hubspot-to-cin7";
  const WINDOW_MIN = 10;
  const modifiedSince = new Date(Date.now() - WINDOW_MIN * 60 * 1000).toISOString();

  if (events.length === 0) {
    return { triggered: false, reason: "no events in payload", reconciler: RECONCILER };
  }

  const objectIds = events.map(e => e && e.objectId).filter(v => v != null);
  const res = await fastn.flow.invokeAsync(RECONCILER, { modifiedSince, limit: 50, maxPages: 2 });
  return { triggered: true, reconciler: RECONCILER, modifiedSince, eventCount: events.length, objectIds, executionId: res && res.executionId };
}