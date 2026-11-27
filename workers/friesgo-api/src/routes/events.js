// Append-Only Idempotent Contact Events & Team Activity Stream

import { requireAuth } from "../auth.js";
import { randomId } from "../crypto.js";
import { json, monotonicOptOut, nowIso, parseJsonBody, writeAuditLog } from "../utils.js";
import { recomputeCompanyDerivedState } from "./companies.js";

const VALID_CHANNELS = new Set(["email", "whatsapp", "phone", "linkedin", "meeting", "quote", "dd", "coordination", "other"]);
const VALID_OUTCOMES = new Set([
  "sent",
  "no_answer",
  "hung_up",
  "replied",
  "inquiry",
  "quote_sent",
  "rejected",
  "unsubscribed",
  "coordinated",
  "note",
]);

export async function handleEventRoutes(request, env, cors, url) {
  const path = url.pathname;
  const method = request.method;

  // 1. Append real business contact event (idempotent by client-generated event_id)
  if (path === "/api/events" && method === "POST") {
    const auth = await requireAuth(request, env, cors);
    if (!auth.ok) return auth.response;
    const body = await parseJsonBody(request, 32768);

    const companyId = String(body.company_id || "").trim();
    if (!companyId) return json({ error: "缺少 company_id" }, 400, cors);

    const comp = await env.DB
      .prepare("SELECT id, canonical_name, opt_out_status, compliance_status, deleted_at FROM companies WHERE id = ?")
      .bind(companyId)
      .first();
    if (!comp || comp.deleted_at) return json({ error: "目标企业不存在" }, 404, cors);

    const channel = VALID_CHANNELS.has(body.channel) ? body.channel : "other";
    const outcome = VALID_OUTCOMES.has(body.action_outcome) ? body.action_outcome : "note";
    const eventId = String(body.event_id || "").trim() || randomId("ev");
    const summary = String(body.summary || "").trim().slice(0, 600);
    const nextAction = String(body.next_action || "").trim().slice(0, 200);
    const nextFollowDate = String(body.next_follow_date || "").trim().slice(0, 20);
    const occurredAt = String(body.occurred_at || "").trim() || nowIso();
    const now = nowIso();

    // Idempotent insert: duplicate retries from offline queue never create duplicate history rows!
    const ins = await env.DB
      .prepare(
        `INSERT OR IGNORE INTO contact_events (
           event_id, company_id, contact_id, employee_id, employee_name, channel,
           action_outcome, summary, next_action, next_follow_date, occurred_at, schema_version, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
      )
      .bind(
        eventId,
        companyId,
        String(body.contact_id || ""),
        auth.actor.id,
        auth.actor.display_name,
        channel,
        outcome,
        summary,
        nextAction,
        nextFollowDate,
        occurredAt,
        now
      )
      .run();

    const wasDuplicate = !(ins && ins.meta && ins.meta.changes > 0);

    if (!wasDuplicate) {
      // Promote company from raw_pending -> active once real outreach occurs; upgrade opt-out monotonically
      let nextOptOut = comp.opt_out_status;
      if (outcome === "unsubscribed") nextOptOut = monotonicOptOut(comp.opt_out_status, "all_blocked");
      else if (outcome === "rejected") nextOptOut = monotonicOptOut(comp.opt_out_status, "marketing_blocked");

      const nextOptMeta =
        nextOptOut !== comp.opt_out_status
          ? JSON.stringify({
              updated_by: auth.actor.display_name,
              updated_at: now,
              channel,
              outcome,
              summary,
            })
          : null;

      await env.DB
        .prepare(
          `UPDATE companies
           SET pool_stage = CASE WHEN pool_stage = 'raw_pending' THEN 'active' ELSE 'active' END,
               next_follow_date = CASE WHEN ? != '' THEN ? ELSE next_follow_date END,
               opt_out_status = ?,
               opt_out_meta_json = COALESCE(?, opt_out_meta_json),
               version = version + 1,
               updated_by = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .bind(nextFollowDate, nextFollowDate, nextOptOut, nextOptMeta, auth.actor.id, now, companyId)
        .run();

      // Release lock ONLY if lock_id matches current employee & device session
      if (body.release_lock_id) {
        await env.DB
          .prepare("DELETE FROM contact_locks WHERE company_id = ? AND lock_id = ? AND employee_id = ? AND session_id = ?")
          .bind(companyId, String(body.release_lock_id), auth.actor.id, auth.sessionId)
          .run();
      }

      if (outcome === "rejected" || outcome === "unsubscribed" || outcome === "coordinated") {
        await writeAuditLog(
          env.DB,
          auth.actor,
          `EVENT_${outcome.toUpperCase()}`,
          "company",
          companyId,
          `${channel}: ${summary}`
        );
      }
    }

    const derivedState = await recomputeCompanyDerivedState(env.DB, companyId);
    return json(
      {
        ok: true,
        event_id: eventId,
        idempotentDuplicate: wasDuplicate,
        derived_contact_status: derivedState ? derivedState.derived : "uncontacted",
      },
      wasDuplicate ? 200 : 201,
      cors
    );
  }

  // 2. Team recent follow-up activity stream
  if (path === "/api/events/recent" && method === "GET") {
    const auth = await requireAuth(request, env, cors);
    if (!auth.ok) return auth.response;
    const limit = Math.min(80, Math.max(10, parseInt(url.searchParams.get("limit") || "40", 10) || 40));
    const onlyMine = url.searchParams.get("mine") === "1";
    const sql = onlyMine
      ? `SELECT ev.*, c.canonical_name, c.country_en, c.derived_contact_status, c.opt_out_status
         FROM contact_events ev
         JOIN companies c ON c.id = ev.company_id
         WHERE ev.employee_id = ? AND c.deleted_at IS NULL
         ORDER BY ev.occurred_at DESC LIMIT ?`
      : `SELECT ev.*, c.canonical_name, c.country_en, c.derived_contact_status, c.opt_out_status
         FROM contact_events ev
         JOIN companies c ON c.id = ev.company_id
         WHERE c.deleted_at IS NULL
         ORDER BY ev.occurred_at DESC LIMIT ?`;
    const stmt = onlyMine ? env.DB.prepare(sql).bind(auth.actor.id, limit) : env.DB.prepare(sql).bind(limit);
    const rows = await stmt.all();
    return json({ ok: true, events: rows.results || [] }, 200, cors);
  }

  return null;
}
