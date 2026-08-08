const QUALIFYING_PROPERTY = "lifecyclestage";
const QUALIFYING_VALUE = "salesqualifiedlead";
// Lead object (objectTypeId 0-136) qualification. Category rather than
// hs_pipeline_stage: stage ids are per-portal (Qualified is 233247981 in one
// portal, different in the next), the category enum is stable everywhere.
const LEAD_STAGE_PROPERTY = "hs_pipeline_stage_category_v2";
const LEAD_STAGE_VALUE = "QUALIFIED";
const PIPELINE = "default";
const DEAL_STAGE = "appointmentscheduled";
const NAME_SUFFIX = " - Qualified lead";
const MAX_DEDUPE_DEALS = 25;

function unwrap(res) { return (res && typeof res === "object" && "output" in res) ? res.output : res; }
function failed(res) { return res && typeof res === "object" && "success" in res && res.success === false; }
function errMsg(res) { return (res && (res.error?.message || res.error || res.status)) ? String(res.error?.message || res.error || res.status) : "unknown error"; }

export default async function(ctx) {
  const out = { created: 0, updated: 0, skipped: 0, errors: 0, errorDetails: [] };
  const raw = ctx.input;
  let events = Array.isArray(raw) ? raw : (Array.isArray(raw?.events) ? raw.events : [raw]);
  events = (events || []).filter(e => e && typeof e === "object");

  for (const ev of events) {
    let contactId = null;
    try {
      const objectId = ev.objectId != null ? String(ev.objectId) : null;
      if (!objectId) {
        out.skipped++; out.errorDetails.push({ kind: "skip", contactId: null, reason: "skipped: notification has no objectId" });
        continue;
      }
      // Two accepted signals: a Lead reaching the Qualified stage category, and
      // the legacy contact lifecyclestage -> salesqualifiedlead. The contact
      // path predates this and other tenants still rely on it, so it stays.
      const isLeadEvent = ev.propertyName === LEAD_STAGE_PROPERTY;
      const isContactEvent = ev.propertyName === QUALIFYING_PROPERTY;
      if (!isLeadEvent && !isContactEvent) {
        out.skipped++; out.errorDetails.push({ kind: "skip", contactId: objectId, reason: "skipped: property is neither " + LEAD_STAGE_PROPERTY + " nor " + QUALIFYING_PROPERTY + " (" + String(ev.propertyName) + ")" });
        continue;
      }
      const wantValue = isLeadEvent ? LEAD_STAGE_VALUE : QUALIFYING_VALUE;
      if (String(ev.propertyValue) !== wantValue) {
        out.skipped++; out.errorDetails.push({ kind: "skip", contactId: objectId, reason: "skipped: value is not '" + wantValue + "' (" + String(ev.propertyValue) + ")" });
        continue;
      }
      if (isLeadEvent) {
        // objectId is a LEAD id, not a contact — resolve the associated contact.
        const laRes = await fastn.connector.hubspot.listAssociations({ fromObjectType: "leads", fromObjectId: objectId, toObjectType: "contacts", limit: 10 });
        if (failed(laRes)) {
          out.errors++; out.errorDetails.push({ kind: "error", leadId: objectId, reason: "lead -> contact association lookup failed: " + errMsg(laRes) });
          continue;
        }
        const laRows = ((unwrap(laRes) || {}).results) || [];
        if (!laRows.length) {
          out.skipped++; out.errorDetails.push({ kind: "skip", leadId: objectId, reason: "skipped: qualified lead has no associated contact — nothing to create a deal for" });
          continue;
        }
        contactId = String(laRows[0].toObjectId);
      } else {
        contactId = objectId;
      }

      const cRes = await fastn.connector.hubspot.getContact({ contactId, properties: "email,firstname,lastname,hubspot_owner_id,lifecyclestage" });
      if (failed(cRes)) {
        out.errors++; out.errorDetails.push({ kind: "error", contactId, reason: "getContact failed / contact not found: " + errMsg(cRes) });
        continue;
      }
      const contact = unwrap(cRes) || {};
      const p = contact.properties || {};
      const nameBase = [p.firstname, p.lastname].filter(Boolean).join(" ") || p.email || ("Contact " + contactId);
      const dealName = nameBase + NAME_SUFFIX;

      const aRes = await fastn.connector.hubspot.listAssociations({ fromObjectType: "contacts", fromObjectId: contactId, toObjectType: "deals", limit: 100 });
      if (failed(aRes)) {
        out.errors++; out.errorDetails.push({ kind: "error", contactId, reason: "dedupe check failed (listAssociations): " + errMsg(aRes) + " - deal NOT created to avoid duplicates" });
        continue;
      }
      const assocIds = ((unwrap(aRes) || {}).results || []).map(r => String(r.toObjectId)).slice(0, MAX_DEDUPE_DEALS);
      let duplicate = false;
      for (const dealId of assocIds) {
        const dRes = await fastn.connector.hubspot.getDeal({ dealId, properties: "dealname" });
        if (failed(dRes)) continue;
        const dn = ((unwrap(dRes) || {}).properties || {}).dealname;
        if (dn === dealName) { duplicate = true; break; }
      }
      if (duplicate) {
        out.skipped++; out.errorDetails.push({ kind: "skip", contactId, reason: "skipped: deal already exists ('" + dealName + "')" });
        continue;
      }

      const dealProps = { dealname: dealName, pipeline: PIPELINE, dealstage: DEAL_STAGE };
      if (p.hubspot_owner_id) dealProps.hubspot_owner_id = p.hubspot_owner_id;
      const createRes = await fastn.connector.hubspot.createDeal({ properties: dealProps });
      if (failed(createRes)) {
        out.errors++; out.errorDetails.push({ kind: "error", contactId, reason: "createDeal failed: " + errMsg(createRes) });
        continue;
      }
      const deal = unwrap(createRes) || {};
      const dealId = deal.id ? String(deal.id) : null;
      if (!dealId) {
        out.errors++; out.errorDetails.push({ kind: "error", contactId, reason: "createDeal returned no deal id" });
        continue;
      }

      const linkRes = await fastn.connector.hubspot.createDefaultAssociation({ fromObjectType: "deals", fromObjectId: dealId, toObjectType: "contacts", toObjectId: contactId });
      if (failed(linkRes)) {
        out.errors++; out.errorDetails.push({ kind: "error", contactId, dealId, reason: "association failed after deal creation (deal " + dealId + " exists, repair manually): " + errMsg(linkRes) });
        continue;
      }

      out.created++;
    } catch (e) {
      out.errors++; out.errorDetails.push({ kind: "error", contactId, reason: "unhandled: " + String(e && e.message ? e.message : e) });
    }
  }
  return out;
}