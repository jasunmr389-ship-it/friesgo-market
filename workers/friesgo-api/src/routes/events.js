// Append-Only Idempotent Contact Events & Team Activity Stream

import { requireLegacyMainInternal } from "../auth.js";
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
    const auth = await requireLegacyMainInternal(request, env, cors);
    if (!auth.ok) return auth.response;
    const body = await parseJsonBody(request, 32768);

    const companyId = String(body.company_id || "").trim();
    if (!companyId) return json({ error: "缺少 company_id" }, 400, cors);

    const comp = auth.v4
      ? await env.DB
          .prepare("SELECT id, canonical_name, opt_out_status, compliance_status, deleted_at FROM companies WHERE id = ? AND org_id = ?")
          .bind(companyId, auth.orgId)
          .first()
      : await env.DB
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

    const reqOptOut =
      outcome === "unsubscribed"
        ? "all_blocked"
        : outcome === "rejected"
          ? "marketing_blocked"
          : "none";
    const nextOptMeta =
      reqOptOut !== "none"
        ? JSON.stringify({
            updated_by: auth.actor.display_name,
            updated_at: now,
            channel,
            outcome,
            summary,
          })
        : "";

    const insStmt = env.DB
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
      );

    // SQL-level monotonic CASE guarantees concurrent stale requests can NEVER downgrade opt_out_status (D03)
    const updStmt = env.DB
      .prepare(
        `UPDATE companies
         SET pool_stage = 'active',
             next_follow_date = CASE WHEN ? != '' THEN ? ELSE next_follow_date END,
             opt_out_status = CASE
               WHEN ? = 'all_blocked' OR opt_out_status = 'all_blocked' THEN 'all_blocked'
               WHEN ? = 'marketing_blocked' OR opt_out_status = 'marketing_blocked' THEN 'marketing_blocked'
               ELSE opt_out_status
             END,
             opt_out_meta_json = CASE WHEN ? != '' THEN ? ELSE opt_out_meta_json END,
             version = version + 1,
             updated_by = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .bind(nextFollowDate, nextFollowDate, reqOptOut, reqOptOut, nextOptMeta, nextOptMeta, auth.actor.id, now, companyId);

    let wasDuplicate = false;
    if (typeof env.DB.batch === "function") {
      // Atomic D1 batch transaction: event insert + monotonic company projection commit or fail together (D04)
      const batchRes = await env.DB.batch([insStmt, updStmt]);
      const ins = batchRes && batchRes[0];
      wasDuplicate = !(ins && ins.meta && ins.meta.changes > 0);
    } else {
      // Fallback for single-statement adapters: insert then monotonic update; retry heals any mid-failure projection
      const ins = await insStmt.run();
      wasDuplicate = !(ins && ins.meta && ins.meta.changes > 0);
      if (!wasDuplicate || reqOptOut !== "none") {
        await updStmt.run();
      }
    }

    // Release lock ONLY if lock_id matches current member & device session (also safe on idempotent retry)
    if (body.release_lock_id) {
      await env.DB
        .prepare("DELETE FROM contact_locks WHERE company_id = ? AND lock_id = ? AND employee_id = ? AND session_id = ?")
        .bind(companyId, String(body.release_lock_id), auth.actor.id, auth.sessionId)
        .run();
    }
    if (reqOptOut !== "none") {
      await env.DB.prepare("DELETE FROM contact_locks WHERE company_id = ?").bind(companyId).run();
    }

    if (!wasDuplicate && (outcome === "rejected" || outcome === "unsubscribed" || outcome === "coordinated")) {
      await writeAuditLog(
        env.DB,
        auth.actor,
        `EVENT_${outcome.toUpperCase()}`,
        "company",
        companyId,
        `${channel}: ${summary}`
      );
    }

    // Always reconcile & self-heal authoritative opt_out_status + derived_contact_status from persisted events (D04)
    const derivedState = await recomputeCompanyDerivedState(env.DB, companyId);
    return json(
      {
        ok: true,
        event_id: eventId,
        idempotentDuplicate: wasDuplicate,
        opt_out_status: derivedState ? derivedState.optOutStatus : comp.opt_out_status,
        derived_contact_status: derivedState ? derivedState.derived : "uncontacted",
      },
      wasDuplicate ? 200 : 201,
      cors
    );
  }

  // 2. Team recent follow-up activity stream
  if (path === "/api/events/recent" && method === "GET") {
    const auth = await requireLegacyMainInternal(request, env, cors);
    if (!auth.ok) return auth.response;
    const limit = Math.min(80, Math.max(10, parseInt(url.searchParams.get("limit") || "40", 10) || 40));
    const onlyMine = url.searchParams.get("mine") === "1";
    const where = ["c.deleted_at IS NULL"];
    const binds = [];
    if (auth.v4) {
      where.push("c.org_id = ?");
      binds.push(auth.orgId);
    }
    if (onlyMine) {
      where.push("ev.employee_id = ?");
      binds.push(auth.actor.id);
    }
    const sql = `SELECT ev.*, c.canonical_name, c.country_en, c.derived_contact_status, c.opt_out_status
       FROM contact_events ev
       JOIN companies c ON c.id = ev.company_id
       WHERE ${where.join(" AND ")}
       ORDER BY ev.occurred_at DESC LIMIT ?`;
    const rows = await env.DB.prepare(sql).bind(...binds, limit).all();
    return json({ ok: true, events: rows.results || [] }, 200, cors);
  }

  return null;
}
