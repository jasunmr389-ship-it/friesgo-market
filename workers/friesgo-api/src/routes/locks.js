// Server-Side Atomic Short-Term Anti-Duplicate Contact Lock (bound to unique lock_id + employee_id + session_id)
// Explicitly NOT customer ownership; expires automatically (default 10 minutes) or upon completion/cancel.

import { requireLegacyMainInternal } from "../auth.js";
import { randomId } from "../crypto.js";
import { addSecondsIso, json, nowIso, parseJsonBody, writeAuditLog } from "../utils.js";
import { recomputeCompanyDerivedState } from "./companies.js";

export async function handleLockRoutes(request, env, cors, url) {
  const path = url.pathname;
  const method = request.method;

  // 1. Atomic acquire short-term contact lock
  if (path === "/api/locks/acquire" && method === "POST") {
    const auth = await requireLegacyMainInternal(request, env, cors);
    if (!auth.ok) return auth.response;
    const body = await parseJsonBody(request, 16384);
    const companyId = String(body.company_id || "").trim();
    const channel = String(body.channel || "general").trim().slice(0, 32);
    if (!companyId) return json({ error: "缺少 company_id" }, 400, cors);

    const comp = auth.v4
      ? await env.DB
          .prepare("SELECT id, canonical_name, opt_out_status, compliance_status, deleted_at, merged_into_id FROM companies WHERE id = ? AND org_id = ?")
          .bind(companyId, auth.orgId)
          .first()
      : await env.DB
          .prepare("SELECT id, canonical_name, opt_out_status, compliance_status, deleted_at, merged_into_id FROM companies WHERE id = ?")
          .bind(companyId)
          .first();
    if (!comp || comp.deleted_at || comp.merged_into_id) {
      return json({ error: "目标企业不存在或已归档/合并", code: "COMPANY_NOT_FOUND" }, 404, cors);
    }

    // Hard block outreach based on latest authoritative opt-out / compliance status
    if (comp.opt_out_status !== "none") {
      return json(
        {
          error: `⛔ 客户「${comp.canonical_name}」已登记拒绝/退订（${comp.opt_out_status}），系统已全员硬阻断主动联系！`,
          code: "OPT_OUT_BLOCKED",
        },
        403,
        cors
      );
    }
    if (comp.compliance_status === "blocked") {
      return json(
        {
          error: `⛔ 客户「${comp.canonical_name}」处于合规禁发/制裁阻断状态，禁止发起业务触达！`,
          code: "COMPLIANCE_BLOCKED",
        },
        403,
        cors
      );
    }

    // Fetch colleague contact history BEFORE acquiring lock so UI can display coordination banner
    const histRes = await env.DB
      .prepare(
        `SELECT event_id, employee_id, employee_name, channel, action_outcome, summary, occurred_at
         FROM contact_events
         WHERE company_id = ?
         ORDER BY occurred_at DESC LIMIT 10`
      )
      .bind(companyId)
      .all();
    const history = histRes.results || [];
    const colleagueHistory = history.filter((h) => h.employee_id !== auth.actor.id);

    const ttlSec = Math.min(1800, Math.max(60, parseInt(env.LOCK_TTL_SECONDS || "600", 10) || 600));
    const now = nowIso();
    const expiresAt = addSecondsIso(ttlSec);
    const lockId = randomId("lck");

    // Single atomic SQLite UPSERT: only succeeds if no active lock exists OR previous lock expired.
    // Note: even the SAME employee on a DIFFERENT device (session_id) will be blocked so two devices cannot collide!
    const won = await env.DB
      .prepare(
        `INSERT INTO contact_locks (company_id, lock_id, employee_id, session_id, employee_name, channel, locked_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(company_id) DO UPDATE SET
           lock_id = excluded.lock_id,
           employee_id = excluded.employee_id,
           session_id = excluded.session_id,
           employee_name = excluded.employee_name,
           channel = excluded.channel,
           locked_at = excluded.locked_at,
           expires_at = excluded.expires_at
         WHERE contact_locks.expires_at <= excluded.locked_at
         RETURNING *`
      )
      .bind(companyId, lockId, auth.actor.id, auth.sessionId, auth.actor.display_name, channel, now, expiresAt)
      .first();

    if (!won) {
      const holder = await env.DB
        .prepare("SELECT company_id, lock_id, employee_id, session_id, employee_name, channel, locked_at, expires_at FROM contact_locks WHERE company_id = ?")
        .bind(companyId)
        .first();
      const sameUserOtherDevice = holder && holder.employee_id === auth.actor.id && holder.session_id !== auth.sessionId;
      return json(
        {
          ok: false,
          code: "LOCK_HELD_BY_OTHER",
          error: sameUserOtherDevice
            ? `🔒 你在另一台设备上正在处理联系「${comp.canonical_name}」（截止 ${holder.expires_at}），请勿跨设备重复发送`
            : `🔒 同事「${(holder && holder.employee_name) || "其他成员"}」正在通过 ${(holder && holder.channel) || "沟通渠道"} 处理联系「${comp.canonical_name}」，请暂勿重复操作（锁定时效至 ${(holder && holder.expires_at) || ""}）`,
          holder: holder
            ? {
                employee_id: holder.employee_id,
                employee_name: holder.employee_name,
                channel: holder.channel,
                locked_at: holder.locked_at,
                expires_at: holder.expires_at,
                same_user_other_device: Boolean(sameUserOtherDevice),
              }
            : null,
          history,
        },
        409,
        cors
      );
    }

    await recomputeCompanyDerivedState(env.DB, companyId);
    await writeAuditLog(env.DB, auth.actor, "ACQUIRE_CONTACT_LOCK", "company", companyId, `lock_id=${lockId}, channel=${channel}, ttl=${ttlSec}s`);

    return json(
      {
        ok: true,
        lock: {
          company_id: companyId,
          lock_id: won.lock_id,
          employee_id: won.employee_id,
          session_id: won.session_id,
          employee_name: won.employee_name,
          channel: won.channel,
          locked_at: won.locked_at,
          expires_at: won.expires_at,
        },
        hasColleagueHistory: colleagueHistory.length > 0,
        colleagueHistory,
        history,
      },
      200,
      cors
    );
  }

  // 2. Renew lock (must match exact company_id + lock_id + employee_id + session_id)
  if (path === "/api/locks/renew" && method === "POST") {
    const auth = await requireLegacyMainInternal(request, env, cors);
    if (!auth.ok) return auth.response;
    const body = await parseJsonBody(request, 8192);
    const companyId = String(body.company_id || "").trim();
    const lockId = String(body.lock_id || "").trim();
    if (!companyId || !lockId) return json({ error: "缺少 company_id 或 lock_id" }, 400, cors);

    const ttlSec = Math.min(1800, Math.max(60, parseInt(env.LOCK_TTL_SECONDS || "600", 10) || 600));
    const now = nowIso();
    const nextExp = addSecondsIso(ttlSec);
    const res = await env.DB
      .prepare(
        "UPDATE contact_locks SET expires_at = ? WHERE company_id = ? AND lock_id = ? AND employee_id = ? AND session_id = ? AND expires_at > ?"
      )
      .bind(nextExp, companyId, lockId, auth.actor.id, auth.sessionId, now)
      .run();
    if (!res || !res.meta || res.meta.changes === 0) {
      return json({ error: "锁续期失败：锁已过期、或与当前设备会话/lock_id 不匹配", code: "LOCK_MISMATCH_OR_EXPIRED" }, 409, cors);
    }
    return json({ ok: true, lock_id: lockId, expires_at: nextExp }, 200, cors);
  }

  // 3. Release lock (strictly checks lock_id + employee_id + session_id so other devices/users CANNOT release it!)
  if (path === "/api/locks/release" && method === "POST") {
    const auth = await requireLegacyMainInternal(request, env, cors);
    if (!auth.ok) return auth.response;
    const body = await parseJsonBody(request, 8192);
    const companyId = String(body.company_id || "").trim();
    const lockId = String(body.lock_id || "").trim();
    if (!companyId || !lockId) return json({ error: "缺少 company_id 或 lock_id" }, 400, cors);

    const res = await env.DB
      .prepare("DELETE FROM contact_locks WHERE company_id = ? AND lock_id = ? AND employee_id = ? AND session_id = ?")
      .bind(companyId, lockId, auth.actor.id, auth.sessionId)
      .run();
    if (!res || !res.meta || res.meta.changes === 0) {
      return json({ error: "无法释放锁：lock_id 不存在、已过期，或属于他人/其他设备", code: "LOCK_RELEASE_DENIED" }, 403, cors);
    }
    await recomputeCompanyDerivedState(env.DB, companyId);
    return json({ ok: true, released: true }, 200, cors);
  }

  return null;
}
