export default async function (ctx) {
  const events = Array.isArray(ctx.input) ? ctx.input : (ctx.input ? [ctx.input] : []);
  const RECONCILER = "c7hs-deal-hubspot-to-cin7";
  const STAGE_HANDLER = "c7hs-dealstage-to-cin7-status";
  const WINDOW_MIN = 10;
  const modifiedSince = new Date(Date.now() - WINDOW_MIN * 60 * 1000).toISOString();

  if (events.length === 0) {
    return { triggered: false, reason: "no events in payload", reconciler: RECONCILER };
  }

  const objectIds = events.map(e => e && (e.objectId ?? e.objectID ?? e.id)).filter(v => v != null).map(String);

  // 1) Existing: nudge the header/lines reconciler (recent window).
  const res = objectIds.length ? await fastn.flow.invokeAsync(RECONCILER, { dealIds: objectIds }) : null;

  // 2) NEW: drive Cin7 sale lifecycle from each changed deal's stage (Closed Won -> authorise, etc.)
  let stageRes = null;
  if (objectIds.length) {
    try { stageRes = await fastn.flow.invokeAsync(STAGE_HANDLER, { dealIds: objectIds }); } catch(e) { stageRes = { error: String(e).slice(0,150) }; }
  }

  return { triggered: true, reconciler: RECONCILER, modifiedSince, eventCount: events.length, objectIds, executionId: res && res.executionId, stageHandler: STAGE_HANDLER, stageExecutionId: stageRes && stageRes.executionId };
}