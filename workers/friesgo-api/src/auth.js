// Authentication, Session Lifecycle, Brute-Force Protection & Mandatory Super-Admin 2FA

import {
  consumeRecoveryCode,
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  hashPassword,
  randomHex,
  randomId,
  sha256Hex,
  timingSafeEqualStr,
  validatePasswordStrength,
  verifyPassword,
} from "./crypto.js";
import { buildOtpAuthUri, generateTotpSecret, verifyTotpCode, verifyTotpCodeWithStep } from "./totp.js";
import {
  addDaysIso,
  addSecondsIso,
  getClientIp,
  json,
  nowIso,
  parseJsonBody,
  safeJsonParse,
  writeAuditLog,
} from "./utils.js";

const MAX_LOGIN_FAILS = 6;
const LOCKOUT_SECONDS = 900; // 15 min lockout after 6 consecutive failures

export function parseQuotaCapStrict(raw, fallbackVal = 250) {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: fallbackVal };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 950) {
    return { ok: false, error: "Google Maps 月度配额须为 0–950 之间的整数（0 代表禁用付费权限）" };
  }
  return { ok: true, value: n };
}

export function sanitizeEmployeePublic(row) {
  if (!row) return null;
  const rawCap = row.gmaps_monthly_cap;
  const cap = rawCap === undefined || rawCap === null || rawCap === "" ? 250 : Number(rawCap);
  return {
    id: row.id,
    login_id: row.login_id,
    display_name: row.display_name,
    role: row.role,
    status: row.status,
    totp_enabled: Boolean(row.totp_enabled),
    must_reset_pwd: Boolean(row.must_reset_pwd),
    gmaps_monthly_cap: Number.isFinite(cap) ? cap : 250,
    created_at: row.created_at,
    updated_at: row.updated_at,
    disabled_at: row.disabled_at || null,
  };
}

export const EXPECTED_SCHEMA_VERSION = 3;

const REQUIRED_V1_TABLES = [
  "employees",
  "sessions",
  "login_rate_limits",
  "companies",
  "company_contacts",
  "company_product_interests",
  "raw_osm_pool",
  "source_evidences",
  "contact_events",
  "contact_locks",
  "quote_records",
  "compliance_order_logs",
  "scrape_task_logs",
  "product_profiles",
  "audit_logs",
  "feedback_items",
  "gmaps_quota_usage",
  "migration_batches",
];

/**
 * Authoritative Fail-Closed maintenance & restore gate check (R04 / R05).
 * Distinguishes:
 *   - Readable & explicitly unfrozen (no row or state_value === '0') + no incomplete/failed restore job -> allowed
 *   - Frozen (state_value === '1') or latest restore job failed/in_progress -> blocked (503 SYSTEM_RESTORE_FROZEN)
 *   - Missing table / DB query failure / corrupt state value -> FAIL-CLOSED blocked (503 SYSTEM_MAINTENANCE_STATE_UNAVAILABLE)
 */
export async function checkSystemMaintenanceGate(db) {
  if (!db) {
    return {
      allowed: false,
      frozen: true,
      readable: false,
      code: "SYSTEM_MAINTENANCE_STATE_UNAVAILABLE",
      error: "数据库连接不可用，系统已按 Fail-Closed 策略暂停业务访问",
      latestJob: null,
    };
  }
  let freezeRow = null;
  try {
    freezeRow = await db
      .prepare("SELECT state_value, meta_json, updated_at FROM system_maintenance_state WHERE state_key = 'restore_freeze'")
      .first();
  } catch {
    return {
      allowed: false,
      frozen: true,
      readable: false,
      code: "SYSTEM_MAINTENANCE_STATE_UNAVAILABLE",
      error: "维护与恢复冻结状态表不可读（Schema 迁移未完成或数据库异常），系统已按 Fail-Closed 策略暂停业务访问",
      latestJob: null,
    };
  }

  let latestJob = null;
  try {
    latestJob = await db
      .prepare(
        `SELECT job_id, status, snapshot_sha256, error_message, started_at, finished_at, verified_at
         FROM restore_jobs
         ORDER BY started_at DESC, rowid DESC
         LIMIT 1`
      )
      .first();
  } catch {
    return {
      allowed: false,
      frozen: true,
      readable: false,
      code: "SYSTEM_MAINTENANCE_STATE_UNAVAILABLE",
      error: "恢复作业台账表不可读（Schema 迁移 v3 未完成或数据库异常），系统已按 Fail-Closed 策略暂停业务访问",
      latestJob: null,
    };
  }

  if (freezeRow && freezeRow.state_value !== "0" && freezeRow.state_value !== "1") {
    return {
      allowed: false,
      frozen: true,
      readable: false,
      code: "SYSTEM_MAINTENANCE_STATE_UNAVAILABLE",
      error: "维护冻结状态值异常，系统已按 Fail-Closed 策略暂停业务访问",
      latestJob: latestJob || null,
    };
  }

  if (latestJob && latestJob.status !== "completed") {
    return {
      allowed: false,
      frozen: true,
      readable: true,
      code: "SYSTEM_RESTORE_FROZEN",
      error: "最近一次备份恢复作业未完成或已失败，系统保持安全冻结（禁止常规重核验解冻，须先完成完整恢复/回滚对账）",
      latestJob,
    };
  }

  if (freezeRow && freezeRow.state_value === "1") {
    return {
      allowed: false,
      frozen: true,
      readable: true,
      code: "SYSTEM_RESTORE_FROZEN",
      error: "系统正处于备份恢复安全冻结期，须总负责人执行「恢复后安全重核验」方可恢复业务访问",
      latestJob: latestJob || null,
    };
  }

  return {
    allowed: true,
    frozen: false,
    readable: true,
    code: null,
    error: "",
    latestJob: latestJob || null,
  };
}

export async function isSystemRestoreFrozen(db) {
  const gate = await checkSystemMaintenanceGate(db);
  return !gate.allowed;
}

export const REQUIRED_V4_SLICE1_TABLES = [
  "orgs",
  "org_memberships",
  "support_access_grants",
  "idempotency_keys",
  "applications",
  "product_catalog_approvals",
  "projects",
  "project_participants",
  "discovery_tasks",
  "demand_signals",
  "inquiries",
  "lead_assignments",
  "assignment_events",
  "deal_registrations",
  "attachments_meta",
];

/**
 * Dynamically probes live SQLite/D1 schema by deployed stage (R05 / REV12).
 * Never hardcodes schemaVersion; never falsely breaks V2.1 tests when optional V3 Slice-1 tables are not yet enabled.
 */
export async function probeSchemaHealth(db, env = null) {
  const v4Required = Boolean(env && String(env.V3_SLICE1_ENABLED || "") === "1");
  const baseExpected = v4Required ? 4 : EXPECTED_SCHEMA_VERSION;
  if (!db) {
    return {
      schemaVersion: 0,
      expectedSchemaVersion: baseExpected,
      schemaReady: false,
      missingSchema: ["database_binding"],
    };
  }
  try {
    const tblRes = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    const tableSet = new Set((tblRes.results || []).map((r) => String((r && r.name) || "")));
    const missingV1 = REQUIRED_V1_TABLES.filter((t) => !tableSet.has(t));
    if (missingV1.length) {
      return {
        schemaVersion: 0,
        expectedSchemaVersion: baseExpected,
        schemaReady: false,
        missingSchema: missingV1,
      };
    }

    const missingV2 = [];
    if (!tableSet.has("system_maintenance_state")) missingV2.push("system_maintenance_state");
    const empColsRes = await db.prepare("PRAGMA table_info(employees)").all();
    const empCols = new Set((empColsRes.results || []).map((r) => String((r && r.name) || "")));
    if (!empCols.has("last_totp_step")) missingV2.push("employees.last_totp_step");

    const missingV3 = [];
    if (!tableSet.has("restore_jobs")) missingV3.push("restore_jobs");

    const v4Present = v4Required || tableSet.has("orgs");
    const expectedVersion = v4Present ? 4 : EXPECTED_SCHEMA_VERSION;
    const missingV4 = [];
    if (v4Present) {
      for (const t of REQUIRED_V4_SLICE1_TABLES) {
        if (!tableSet.has(t)) missingV4.push(t);
      }
      const compColsRes = await db.prepare("PRAGMA table_info(companies)").all();
      const compCols = new Set((compColsRes.results || []).map((r) => String((r && r.name) || "")));
      if (!compCols.has("org_id")) missingV4.push("companies.org_id");
    }

    let detectedVersion = 1;
    if (!missingV2.length) {
      detectedVersion = 2;
      if (!missingV3.length) {
        detectedVersion = 3;
        if (v4Present && !missingV4.length) detectedVersion = 4;
      }
    }

    const missingSchema = [...missingV2, ...missingV3, ...(v4Present ? missingV4 : [])];
    return {
      schemaVersion: detectedVersion,
      expectedSchemaVersion: expectedVersion,
      schemaReady: missingSchema.length === 0,
      missingSchema,
    };
  } catch {
    return {
      schemaVersion: 0,
      expectedSchemaVersion: baseExpected,
      schemaReady: false,
      missingSchema: ["schema_probe_failed"],
    };
  }
}

/**
 * REV01: Authoritative multi-tenant logical isolation context resolver.
 * - Requires explicit X-FG-Org-Id when actor has multiple orgs or operates outside legacy main-only mode.
 * - Never silently falls back to org_friesgo_main on missing/invalid context.
 * - Denies super_admin default access to independent_trial orgs unless an explicit, unexpired, unrevoked support_access_grants record exists!
 */
export async function resolveTenantContext(request, env, auth, cors, opts = {}) {
  const reqOrgId = String(request.headers.get("X-FG-Org-Id") || "").trim();
  const reqMemId = String(request.headers.get("X-FG-Membership-Id") || "").trim();
  const now = nowIso();

  const memRowsRes = await env.DB
    .prepare(
      `SELECT m.*, o.org_type, o.name AS org_name, o.status AS org_status, o.settings_json AS org_settings_json
       FROM org_memberships m
       JOIN orgs o ON o.id = m.org_id
       WHERE m.employee_id = ? AND m.status = 'active' AND o.status = 'active'
       ORDER BY CASE o.org_type WHEN 'company_main' THEN 0 ELSE 1 END, m.created_at ASC`
    )
    .bind(auth.actor.id)
    .all();
  const memberships = memRowsRes.results || [];

  // Backward compatibility ONLY for legacy main-org internal employees who have 0 explicit org_memberships rows
  if (!memberships.length && ["super_admin", "manager", "staff"].includes(auth.actor.role)) {
    if (reqOrgId && reqOrgId !== "org_friesgo_main") {
      // Check if super_admin has an explicit user-approved support grant for an independent_trial org
      if (auth.actor.role === "super_admin") {
        const grant = await env.DB
          .prepare(
            `SELECT g.*, o.org_type, o.name AS org_name, o.status AS org_status, o.settings_json AS org_settings_json
             FROM support_access_grants g
             JOIN orgs o ON o.id = g.org_id
             WHERE g.org_id = ? AND g.grantee_employee_id = ? AND g.revoked_at IS NULL AND g.expires_at > ? AND o.status = 'active'
             LIMIT 1`
          )
          .bind(reqOrgId, auth.actor.id, now)
          .first();
        if (grant) {
          await writeAuditLog(env.DB, auth.actor, "SUPPORT_GRANT_ACCESS", "org", reqOrgId, `grant_id=${grant.id} scope=${grant.scope}`);
          return {
            ok: true,
            orgId: reqOrgId,
            orgType: grant.org_type,
            orgName: grant.org_name,
            orgSettings: safeJsonParse(grant.org_settings_json, {}),
            role: "support_readonly",
            canFinanceSettle: false,
            supportGrantId: grant.id,
            membership: null,
          };
        }
      }
      return {
        ok: false,
        response: json(
          {
            error: "无权访问目标数据空间（多租户逻辑隔离拦截；独立空间需用户限时授权工单）",
            code: "ORG_ACCESS_DENIED",
          },
          403,
          cors
        ),
      };
    }
    if (opts.requireExplicitOrgHeader && !reqOrgId) {
      return {
        ok: false,
        response: json({ error: "缺少明确的数据空间上下文头 X-FG-Org-Id", code: "ORG_CONTEXT_REQUIRED" }, 403, cors),
      };
    }
    const mainOrg = await env.DB.prepare("SELECT * FROM orgs WHERE id = 'org_friesgo_main'").first();
    return {
      ok: true,
      orgId: "org_friesgo_main",
      orgType: (mainOrg && mainOrg.org_type) || "company_main",
      orgName: (mainOrg && mainOrg.name) || "FriesGo Global",
      orgSettings: safeJsonParse(mainOrg && mainOrg.settings_json, {}),
      role: auth.actor.role,
      canFinanceSettle: auth.actor.role === "super_admin",
      supportGrantId: null,
      membership: null,
    };
  }

  // Actor HAS explicit org_memberships -> strict context matching (never silently fall back to company_main!)
  if (!reqOrgId) {
    if (opts.requireExplicitOrgHeader || memberships.length > 1) {
      return {
        ok: false,
        response: json(
          { error: "请显式选择并携带数据空间上下文 X-FG-Org-Id，严禁默认回落主空间", code: "ORG_CONTEXT_REQUIRED" },
          403,
          cors
        ),
      };
    }
  }

  const targetOrgId = reqOrgId || (memberships[0] && memberships[0].org_id) || "";
  if (!targetOrgId) {
    return {
      ok: false,
      response: json({ error: "当前账号无有效已激活组织身份", code: "ORG_CONTEXT_REQUIRED" }, 403, cors),
    };
  }

  let chosen = memberships.find((m) => m.org_id === targetOrgId && (!reqMemId || m.id === reqMemId));
  if (!chosen) {
    // Allow explicit time-bounded user support grant for super_admin on independent_trial org
    if (auth.actor.role === "super_admin") {
      const grant = await env.DB
        .prepare(
          `SELECT g.*, o.org_type, o.name AS org_name, o.status AS org_status, o.settings_json AS org_settings_json
           FROM support_access_grants g
           JOIN orgs o ON o.id = g.org_id
           WHERE g.org_id = ? AND g.grantee_employee_id = ? AND g.revoked_at IS NULL AND g.expires_at > ? AND o.status = 'active'
           LIMIT 1`
        )
        .bind(targetOrgId, auth.actor.id, now)
        .first();
      if (grant) {
        await writeAuditLog(env.DB, auth.actor, "SUPPORT_GRANT_ACCESS", "org", targetOrgId, `grant_id=${grant.id} scope=${grant.scope}`);
        return {
          ok: true,
          orgId: targetOrgId,
          orgType: grant.org_type,
          orgName: grant.org_name,
          orgSettings: safeJsonParse(grant.org_settings_json, {}),
          role: "support_readonly",
          canFinanceSettle: false,
          supportGrantId: grant.id,
          membership: null,
        };
      }
    }
    return {
      ok: false,
      response: json(
        { error: "无权访问所请求的数据空间或成员身份已失效", code: "ORG_ACCESS_DENIED" },
        403,
        cors
      ),
    };
  }

  if (Array.isArray(opts.allowedRoles) && opts.allowedRoles.length && !opts.allowedRoles.includes(chosen.role)) {
    return {
      ok: false,
      response: json({ error: "当前空间角色无权执行此操作", code: "FORBIDDEN_ORG_ROLE" }, 403, cors),
    };
  }

  return {
    ok: true,
    orgId: chosen.org_id,
    orgType: chosen.org_type,
    orgName: chosen.org_name,
    orgSettings: safeJsonParse(chosen.org_settings_json, {}),
    role: chosen.role,
    canFinanceSettle: Boolean(chosen.can_finance_settle) || chosen.role === "super_admin",
    supportGrantId: null,
    membership: chosen,
  };
}

/**
 * ENG01: Strong Idempotency Guard with request SHA-256 binding & in_progress lease recovery.
 * Caller MUST authenticate via requireAuth BEFORE invoking this so revoked sessions never replay cached responses!
 */
export async function runIdempotentOperation(
  db,
  { orgId, actorId, scope, targetId = "", idemKey, requestBody, leaseSeconds = 30, executor }
) {
  const cleanKey = String(idemKey || "").trim();
  if (!cleanKey) {
    return executor();
  }
  const reqHash = await sha256Hex(JSON.stringify(requestBody || {}));
  const now = nowIso();
  const leaseUntil = addSecondsIso(leaseSeconds);

  const existing = await db
    .prepare(
      `SELECT request_sha256, state, response_status, response_json, lease_expires_at
       FROM idempotency_keys
       WHERE org_id = ? AND actor_id = ? AND scope = ? AND target_id = ? AND idem_key = ?`
    )
    .bind(orgId, actorId, scope, targetId, cleanKey)
    .first();

  if (existing) {
    if (existing.request_sha256 !== reqHash) {
      return {
        status: 409,
        body: {
          ok: false,
          code: "IDEMPOTENCY_PAYLOAD_MISMATCH",
          error: "同一幂等编号不允许修改请求内容、金额或目标组织",
        },
        replayed: false,
      };
    }
    if (existing.state === "completed") {
      return {
        status: Number(existing.response_status || 200),
        body: safeJsonParse(existing.response_json, { ok: true }),
        replayed: true,
      };
    }
    if (existing.state === "in_progress" && existing.lease_expires_at > now) {
      return {
        status: 409,
        body: {
          ok: false,
          code: "IDEMPOTENCY_IN_PROGRESS",
          error: "相同请求正在处理中，请稍候重试（已拦截并发重复提交）",
        },
        replayed: false,
      };
    }
    // Lease expired -> recover stuck in_progress record atomically
    const takeover = await db
      .prepare(
        `UPDATE idempotency_keys
         SET lease_expires_at = ?, updated_at = ?
         WHERE org_id = ? AND actor_id = ? AND scope = ? AND target_id = ? AND idem_key = ? AND state = 'in_progress' AND lease_expires_at <= ?`
      )
      .bind(leaseUntil, now, orgId, actorId, scope, targetId, cleanKey, now)
      .run();
    if (Number((takeover && takeover.meta && takeover.meta.changes) || 0) !== 1) {
      return {
        status: 409,
        body: { ok: false, code: "IDEMPOTENCY_IN_PROGRESS", error: "并发幂等争用，请稍后重试" },
        replayed: false,
      };
    }
  } else {
    try {
      await db
        .prepare(
          `INSERT INTO idempotency_keys (org_id, actor_id, scope, target_id, idem_key, request_sha256, state, response_status, response_json, lease_expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'in_progress', 0, '{}', ?, ?, ?)`
        )
        .bind(orgId, actorId, scope, targetId, cleanKey, reqHash, leaseUntil, now, now)
        .run();
    } catch {
      return {
        status: 409,
        body: { ok: false, code: "IDEMPOTENCY_IN_PROGRESS", error: "相同幂等请求并发到达，请稍后重试" },
        replayed: false,
      };
    }
  }

  try {
    const out = await executor();
    const outStatus = Number((out && out.status) || 200);
    const outBody = (out && out.body) || { ok: outStatus < 400 };
    // Persist completed response (do NOT cache 5xx transient server failures so client can retry safely)
    if (outStatus < 500) {
      await db
        .prepare(
          `UPDATE idempotency_keys
           SET state = 'completed', response_status = ?, response_json = ?, updated_at = ?
           WHERE org_id = ? AND actor_id = ? AND scope = ? AND target_id = ? AND idem_key = ?`
        )
        .bind(outStatus, JSON.stringify(outBody), nowIso(), orgId, actorId, scope, targetId, cleanKey)
        .run();
    } else {
      await db
        .prepare(
          `DELETE FROM idempotency_keys
           WHERE org_id = ? AND actor_id = ? AND scope = ? AND target_id = ? AND idem_key = ? AND state = 'in_progress'`
        )
        .bind(orgId, actorId, scope, targetId, cleanKey)
        .run();
    }
    return { status: outStatus, body: outBody, replayed: false };
  } catch (err) {
    // Release in_progress lease on unhandled exception so retries are never permanently deadlocked
    try {
      await db
        .prepare(
          `DELETE FROM idempotency_keys
           WHERE org_id = ? AND actor_id = ? AND scope = ? AND target_id = ? AND idem_key = ? AND state = 'in_progress'`
        )
        .bind(orgId, actorId, scope, targetId, cleanKey)
        .run();
    } catch {}
    throw err;
  }
}

async function checkRateLimit(db, bucketKey) {
  const row = await db
    .prepare("SELECT fail_count, locked_until FROM login_rate_limits WHERE bucket_key = ?")
    .bind(bucketKey)
    .first();
  if (!row) return { blocked: false, failCount: 0 };
  if (row.locked_until && row.locked_until > nowIso()) {
    return { blocked: true, lockedUntil: row.locked_until, failCount: row.fail_count };
  }
  return { blocked: false, failCount: Number(row.fail_count || 0) };
}

async function recordLoginFailure(db, bucketKey) {
  const now = nowIso();
  const row = await db
    .prepare("SELECT fail_count, locked_until FROM login_rate_limits WHERE bucket_key = ?")
    .bind(bucketKey)
    .first();
  const prev = row && (!row.locked_until || row.locked_until <= now) ? Number(row.fail_count || 0) : 0;
  const next = prev + 1;
  const lockUntil = next >= MAX_LOGIN_FAILS ? addSecondsIso(LOCKOUT_SECONDS) : null;
  await db
    .prepare(
      `INSERT INTO login_rate_limits (bucket_key, fail_count, locked_until, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(bucket_key) DO UPDATE SET
         fail_count = excluded.fail_count,
         locked_until = excluded.locked_until,
         updated_at = excluded.updated_at`
    )
    .bind(bucketKey, next, lockUntil, now)
    .run();
  return { failCount: next, lockedUntil: lockUntil };
}

async function clearRateLimit(db, bucketKey) {
  await db.prepare("DELETE FROM login_rate_limits WHERE bucket_key = ?").bind(bucketKey).run();
}

export async function verifyEmployeeTotpOrRecovery(db, employeeRow, code, env, opts = {}) {
  const cleanCode = String(code || "").trim();
  if (!cleanCode) return { ok: false, error: "请输入 6 位动态验证码或一次性应急恢复码" };
  if (!employeeRow.totp_secret_enc) {
    return { ok: false, error: "当前账号尚未完成 2FA 密钥绑定" };
  }
  const secretBase32 = await decryptSecret(employeeRow.totp_secret_enc, env.TOTP_ENC_KEY);
  const totpRes = await verifyTotpCodeWithStep(secretBase32, cleanCode);
  if (totpRes.ok) {
    if (opts.enforceNoReplay) {
      const prevStep = Number(employeeRow.last_totp_step || 0);
      if (totpRes.step <= prevStep) {
        return {
          ok: false,
          code: "TOTP_REPLAY_REJECTED",
          error: "该 6 位动态验证码已用于登录，请等待手机验证器刷新下一组动态码后重试",
        };
      }
      try {
        await db
          .prepare("UPDATE employees SET last_totp_step = ?, updated_at = ? WHERE id = ?")
          .bind(totpRes.step, nowIso(), employeeRow.id)
          .run();
      } catch {
        // Safe fallback if migration 0002 not yet applied on an older DB
      }
    }
    return { ok: true, usedRecovery: false, step: totpRes.step };
  }

  // Try single-use recovery code
  const hashedCodes = safeJsonParse(employeeRow.recovery_codes_hash_json, []);
  const rec = await consumeRecoveryCode(cleanCode, hashedCodes, env.AUTH_PEPPER);
  if (rec.matched) {
    await db
      .prepare("UPDATE employees SET recovery_codes_hash_json = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(rec.remaining), nowIso(), employeeRow.id)
      .run();
    return { ok: true, usedRecovery: true, remainingRecoveryCount: rec.remaining.length };
  }
  return { ok: false, error: "动态验证码或应急恢复码无效" };
}

async function issueSession(db, employeeId, deviceLabel, uaFingerprint, ttlDays = 30) {
  const rawToken = `fgs_${randomHex(32)}`;
  const tokenHash = await sha256Hex(rawToken);
  const sessionId = randomId("ses");
  const now = nowIso();
  const expiresAt = addDaysIso(ttlDays);
  await db
    .prepare(
      `INSERT INTO sessions (session_id, token_hash, employee_id, device_label, ua_fingerprint, expires_at, revoked_at, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`
    )
    .bind(
      sessionId,
      tokenHash,
      employeeId,
      String(deviceLabel || "Web Browser").slice(0, 80),
      String(uaFingerprint || "").slice(0, 120),
      expiresAt,
      now,
      now
    )
    .run();
  return { token: rawToken, sessionId, expiresAt };
}

/**
 * Authoritative server-side auth middleware. Always queries D1 live state:
 * - revoked session or disabled member -> immediate 401 SESSION_REVOKED_OR_DISABLED
 * - restore_freeze maintenance lock -> immediate 503 SYSTEM_RESTORE_FROZEN for all business routes
 * - super_admin without totp_enabled=1 -> restricted to TOTP enrollment routes only
 */
export async function requireAuth(request, env, cors, opts = {}) {
  const authHeader = request.headers.get("Authorization") || "";
  const m = authHeader.match(/^Bearer\s+(\S+)$/i);
  if (!m) {
    return {
      ok: false,
      response: json({ error: "需要成员身份认证后方可访问", code: "AUTH_REQUIRED" }, 401, cors),
    };
  }
  const tokenHash = await sha256Hex(m[1]);
  const now = nowIso();
  const row = await env.DB
    .prepare(
      `SELECT
         s.session_id, s.expires_at, s.revoked_at, s.last_seen_at, s.device_label,
         e.id, e.login_id, e.display_name, e.role, e.status, e.totp_enabled, e.totp_secret_enc,
         e.recovery_codes_hash_json, e.must_reset_pwd, e.gmaps_monthly_cap, e.created_at, e.updated_at, e.disabled_at
       FROM sessions s
       JOIN employees e ON e.id = s.employee_id
       WHERE s.token_hash = ?`
    )
    .bind(tokenHash)
    .first();

  if (!row || row.revoked_at || row.expires_at <= now || row.status !== "active") {
    return {
      ok: false,
      response: json(
        {
          error: "登录会话已失效、被撤销或账号已停用，请重新登录",
          code: "SESSION_REVOKED_OR_DISABLED",
        },
        401,
        cors
      ),
    };
  }

  // D05 / R04 / R05: Fail-Closed restore maintenance freeze & schema integrity gate
  if (!opts.allowDuringRestoreFreeze) {
    const gate = await checkSystemMaintenanceGate(env.DB);
    if (!gate.allowed) {
      return {
        ok: false,
        response: json(
          {
            error: gate.error,
            code: gate.code || "SYSTEM_RESTORE_FROZEN",
          },
          503,
          cors
        ),
      };
    }
  }

  // Mandatory 2FA gate for super_admin on all business/admin endpoints
  if (row.role === "super_admin" && !row.totp_enabled && !opts.allowPendingTotpSetup) {
    return {
      ok: false,
      response: json(
        {
          error: "总负责人账号必须先完成双重身份验证（2FA）绑定后方可使用系统",
          code: "TOTP_SETUP_REQUIRED",
        },
        403,
        cors
      ),
    };
  }

  if (Array.isArray(opts.roles) && opts.roles.length && !opts.roles.includes(row.role)) {
    return {
      ok: false,
      response: json({ error: "权限不足，仅授权角色可执行此操作", code: "FORBIDDEN_ROLE" }, 403, cors),
    };
  }

  // Throttle last_seen_at write to reduce D1 write rows (update once per >=5 min)
  const lastMs = Date.parse(row.last_seen_at || "") || 0;
  if (Date.now() - lastMs > 300000) {
    await env.DB
      .prepare("UPDATE sessions SET last_seen_at = ? WHERE session_id = ?")
      .bind(now, row.session_id)
      .run();
  }

  return {
    ok: true,
    actor: row,
    sessionId: row.session_id,
  };
}

export async function handleAuthRoutes(request, env, cors, url) {
  const path = url.pathname;
  const method = request.method;

  // 1. One-time super_admin bootstrap (only works when employees table is empty + valid BOOTSTRAP_SECRET)
  if (path === "/api/auth/bootstrap" && method === "POST") {
    if (!env.BOOTSTRAP_SECRET || String(env.BOOTSTRAP_SECRET).length < 16) {
      return json({ error: "初始化接口未开启或已关闭", code: "BOOTSTRAP_DISABLED" }, 403, cors);
    }
    const provided = request.headers.get("X-Bootstrap-Secret") || "";
    if (!timingSafeEqualStr(provided, env.BOOTSTRAP_SECRET)) {
      return json({ error: "初始化密钥无效", code: "INVALID_BOOTSTRAP_SECRET" }, 401, cors);
    }
    const existing = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM employees").first();
    if (Number((existing && existing.cnt) || 0) > 0) {
      return json({ error: "系统已完成初始化，禁止重复创建最高管理员", code: "ALREADY_BOOTSTRAPPED" }, 409, cors);
    }
    const body = await parseJsonBody(request, 16384);
    const loginId = String(body.login_id || "").trim().toLowerCase();
    const displayName = String(body.display_name || "").trim();
    const password = String(body.password || "");
    if (!/^[a-z0-9._-]{3,32}$/.test(loginId)) {
      return json({ error: "登录名须为 3–32 位小写字母、数字、点或下划线" }, 400, cors);
    }
    if (!displayName || displayName.length > 40) {
      return json({ error: "请填写 1–40 字的管理员姓名" }, 400, cors);
    }
    const pwCheck = validatePasswordStrength(password);
    if (!pwCheck.ok) return json({ error: pwCheck.error }, 400, cors);

    const hashed = await hashPassword(password, env.AUTH_PEPPER);
    const empId = randomId("emp");
    const now = nowIso();
    await env.DB
      .prepare(
        `INSERT INTO employees (id, login_id, display_name, role, status, pwd_hash, pwd_salt, pwd_iter, totp_secret_enc, totp_enabled, recovery_codes_hash_json, must_reset_pwd, gmaps_monthly_cap, schema_version, created_at, updated_at)
         VALUES (?, ?, ?, 'super_admin', 'active', ?, ?, ?, '', 0, '[]', 0, 950, 1, ?, ?)`
      )
      .bind(empId, loginId, displayName, hashed.hashHex, hashed.saltHex, hashed.iterations, now, now)
      .run();

    await writeAuditLog(env.DB, { id: empId, display_name: displayName }, "BOOTSTRAP_SUPER_ADMIN", "employee", empId, `login_id=${loginId}`);
    return json(
      {
        ok: true,
        employee: { id: empId, login_id: loginId, display_name: displayName, role: "super_admin", totp_enabled: false },
        nextStep: "请立即使用该账号登录并完成最高管理员强制 2FA（TOTP）绑定，同时删除 BOOTSTRAP_SECRET。",
      },
      201,
      cors
    );
  }

  // 2. Employee / Admin Login
  if (path === "/api/auth/login" && method === "POST") {
    const body = await parseJsonBody(request, 16384);
    const loginId = String(body.login_id || "").trim().toLowerCase();
    const password = String(body.password || "");
    const totpCode = String(body.totp_code || "").trim();
    const deviceLabel = String(body.device_label || "").trim() || "Web Browser";
    if (!loginId || !password) {
      return json({ error: "请输入登录名与密码" }, 400, cors);
    }

    const ip = getClientIp(request);
    const bucketKey = `${ip}|${loginId}`;
    const rl = await checkRateLimit(env.DB, bucketKey);
    if (rl.blocked) {
      return json(
        { error: "连续登录失败次数过多，已临时锁定 15 分钟，请稍后重试", code: "RATE_LIMITED", lockedUntil: rl.lockedUntil },
        429,
        cors
      );
    }

    const emp = await env.DB.prepare("SELECT * FROM employees WHERE login_id = ?").bind(loginId).first();
    if (!emp || emp.status !== "active") {
      await recordLoginFailure(env.DB, bucketKey);
      return json({ error: "登录名、密码错误或账号已停用", code: "INVALID_CREDENTIALS" }, 401, cors);
    }

    const pwOk = await verifyPassword(password, env.AUTH_PEPPER, emp.pwd_salt, emp.pwd_hash, emp.pwd_iter);
    if (!pwOk) {
      const fail = await recordLoginFailure(env.DB, bucketKey);
      return json(
        {
          error: fail.lockedUntil
            ? "连续登录失败次数过多，已临时锁定 15 分钟"
            : "登录名或密码错误",
          code: fail.lockedUntil ? "RATE_LIMITED" : "INVALID_CREDENTIALS",
        },
        fail.lockedUntil ? 429 : 401,
        cors
      );
    }

    // Super-admin mandatory 2FA enforcement (with same-window login replay protection)
    if (emp.role === "super_admin" && emp.totp_enabled) {
      if (!totpCode) {
        return json(
          { ok: false, requireTotp: true, message: "总负责人账号请输入 6 位 TOTP 动态验证码（或一次性恢复码）" },
          200,
          cors
        );
      }
      const totpRes = await verifyEmployeeTotpOrRecovery(env.DB, emp, totpCode, env, { enforceNoReplay: true });
      if (!totpRes.ok) {
        await recordLoginFailure(env.DB, bucketKey);
        return json({ error: totpRes.error, code: totpRes.code || "INVALID_TOTP", requireTotp: true }, 401, cors);
      }
    }

    await clearRateLimit(env.DB, bucketKey);
    const ttlDays = Math.min(30, Math.max(1, parseInt(env.SESSION_TTL_DAYS || "30", 10) || 30));
    const ua = request.headers.get("User-Agent") || "";
    const sess = await issueSession(env.DB, emp.id, deviceLabel, ua, ttlDays);
    await writeAuditLog(env.DB, emp, "LOGIN", "session", sess.sessionId, `device=${deviceLabel}`);

    return json(
      {
        ok: true,
        token: sess.token,
        sessionId: sess.sessionId,
        expiresAt: sess.expiresAt,
        requireTotpSetup: emp.role === "super_admin" && !emp.totp_enabled,
        employee: sanitizeEmployeePublic(emp),
      },
      200,
      cors
    );
  }

  // 3. Super-Admin Mandatory TOTP 2FA Setup (Step 1: generate secret & recovery codes)
  if (path === "/api/auth/totp/setup" && method === "POST") {
    const auth = await requireAuth(request, env, cors, { roles: ["super_admin"], allowPendingTotpSetup: true });
    if (!auth.ok) return auth.response;
    if (auth.actor.totp_enabled) {
      return json({ error: "2FA 已启用；如需重绑请先验证现有 2FA 后重置", code: "TOTP_ALREADY_ENABLED" }, 409, cors);
    }
    const secretBase32 = generateTotpSecret(20);
    const secretEnc = await encryptSecret(secretBase32, env.TOTP_ENC_KEY);
    const { plainCodes, hashedCodes } = await generateRecoveryCodes(env.AUTH_PEPPER, 8);
    await env.DB
      .prepare("UPDATE employees SET totp_secret_enc = ?, recovery_codes_hash_json = ?, updated_at = ? WHERE id = ?")
      .bind(secretEnc, JSON.stringify(hashedCodes), nowIso(), auth.actor.id)
      .run();
    const otpauthUri = buildOtpAuthUri(secretBase32, auth.actor.login_id, "FriesGo Global");
    return json(
      {
        ok: true,
        secretBase32,
        otpauthUri,
        recoveryCodes: plainCodes,
        note: "请用手机验证器 App 扫描/手动录入密钥，妥善抄存 8 组一次性应急恢复码（仅展示这一次），然后输入 6 位动态码确认启用。",
      },
      200,
      cors
    );
  }

  // 4. Super-Admin Mandatory TOTP 2FA Confirm (Step 2: verify first 6-digit code -> activate)
  if (path === "/api/auth/totp/confirm" && method === "POST") {
    const auth = await requireAuth(request, env, cors, { roles: ["super_admin"], allowPendingTotpSetup: true });
    if (!auth.ok) return auth.response;
    const body = await parseJsonBody(request, 8192);
    const code = String(body.totp_code || "").trim();
    if (!auth.actor.totp_secret_enc) {
      return json({ error: "请先点击生成 2FA 密钥" }, 400, cors);
    }
    const secretBase32 = await decryptSecret(auth.actor.totp_secret_enc, env.TOTP_ENC_KEY);
    const valid = await verifyTotpCode(secretBase32, code);
    if (!valid) {
      return json({ error: "6 位动态验证码不匹配，请核对手机时间后重试", code: "INVALID_TOTP" }, 400, cors);
    }
    await env.DB
      .prepare("UPDATE employees SET totp_enabled = 1, updated_at = ? WHERE id = ?")
      .bind(nowIso(), auth.actor.id)
      .run();
    await writeAuditLog(env.DB, auth.actor, "ENABLE_TOTP_2FA", "employee", auth.actor.id, "super_admin mandatory 2FA activated");
    return json({ ok: true, totp_enabled: true }, 200, cors);
  }

  // 5. Current authenticated profile
  if (path === "/api/auth/me" && method === "GET") {
    const auth = await requireAuth(request, env, cors, { allowPendingTotpSetup: true, allowDuringRestoreFreeze: true });
    if (!auth.ok) return auth.response;
    const gate = await checkSystemMaintenanceGate(env.DB);
    return json(
      {
        ok: true,
        sessionId: auth.sessionId,
        restoreFrozen: !gate.allowed,
        maintenanceGateCode: gate.code || null,
        latestRestoreJob: gate.latestJob
          ? {
              job_id: gate.latestJob.job_id,
              status: gate.latestJob.status,
              started_at: gate.latestJob.started_at,
              finished_at: gate.latestJob.finished_at || null,
              verified_at: gate.latestJob.verified_at || null,
            }
          : null,
        requireTotpSetup: auth.actor.role === "super_admin" && !auth.actor.totp_enabled,
        employee: sanitizeEmployeePublic(auth.actor),
      },
      200,
      cors
    );
  }

  // 6. Logout (revoke current device session)
  if (path === "/api/auth/logout" && method === "POST") {
    const auth = await requireAuth(request, env, cors, { allowPendingTotpSetup: true, allowDuringRestoreFreeze: true });
    if (!auth.ok) return auth.response;
    await env.DB
      .prepare("UPDATE sessions SET revoked_at = ? WHERE session_id = ?")
      .bind(nowIso(), auth.sessionId)
      .run();
    await writeAuditLog(env.DB, auth.actor, "LOGOUT", "session", auth.sessionId, "self logout");
    return json({ ok: true }, 200, cors);
  }

  // 7. Self password change (rate-limited against brute-force; revokes other sessions)
  if (path === "/api/auth/change-password" && method === "POST") {
    const auth = await requireAuth(request, env, cors);
    if (!auth.ok) return auth.response;
    const chBucket = `chpwd|${auth.actor.id}`;
    const chRl = await checkRateLimit(env.DB, chBucket);
    if (chRl.blocked) {
      return json(
        { error: "原密码连续输错次数过多，已临时锁定 15 分钟，请稍后再试", code: "RATE_LIMITED", lockedUntil: chRl.lockedUntil },
        429,
        cors
      );
    }
    const body = await parseJsonBody(request, 8192);
    const oldPwd = String(body.old_password || "");
    const newPwd = String(body.new_password || "");
    const empFull = await env.DB.prepare("SELECT * FROM employees WHERE id = ?").bind(auth.actor.id).first();
    const okOld = await verifyPassword(oldPwd, env.AUTH_PEPPER, empFull.pwd_salt, empFull.pwd_hash, empFull.pwd_iter);
    if (!okOld) {
      const fail = await recordLoginFailure(env.DB, chBucket);
      return json(
        {
          error: fail.lockedUntil ? "原密码连续输错次数过多，已临时锁定 15 分钟" : "原密码不正确",
          code: fail.lockedUntil ? "RATE_LIMITED" : "INVALID_OLD_PASSWORD",
        },
        fail.lockedUntil ? 429 : 400,
        cors
      );
    }
    await clearRateLimit(env.DB, chBucket);
    const pwCheck = validatePasswordStrength(newPwd);
    if (!pwCheck.ok) return json({ error: pwCheck.error }, 400, cors);

    const hashed = await hashPassword(newPwd, env.AUTH_PEPPER);
    const now = nowIso();
    await env.DB
      .prepare("UPDATE employees SET pwd_hash = ?, pwd_salt = ?, pwd_iter = ?, must_reset_pwd = 0, updated_at = ? WHERE id = ?")
      .bind(hashed.hashHex, hashed.saltHex, hashed.iterations, now, auth.actor.id)
      .run();
    await env.DB
      .prepare("UPDATE sessions SET revoked_at = ? WHERE employee_id = ? AND session_id != ? AND revoked_at IS NULL")
      .bind(now, auth.actor.id, auth.sessionId)
      .run();
    await writeAuditLog(env.DB, auth.actor, "CHANGE_PASSWORD", "employee", auth.actor.id, "other device sessions revoked");
    return json({ ok: true }, 200, cors);
  }

  // 8. List & revoke own device sessions
  if (path === "/api/auth/sessions" && method === "GET") {
    const auth = await requireAuth(request, env, cors);
    if (!auth.ok) return auth.response;
    const rows = await env.DB
      .prepare(
        "SELECT session_id, device_label, expires_at, last_seen_at, created_at FROM sessions WHERE employee_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC"
      )
      .bind(auth.actor.id, nowIso())
      .all();
    return json({ ok: true, currentSessionId: auth.sessionId, sessions: rows.results || [] }, 200, cors);
  }

  const sesDelMatch = path.match(/^\/api\/auth\/sessions\/([^/]+)$/);
  if (sesDelMatch && method === "DELETE") {
    const auth = await requireAuth(request, env, cors);
    if (!auth.ok) return auth.response;
    const targetSid = decodeURIComponent(sesDelMatch[1]);
    await env.DB
      .prepare("UPDATE sessions SET revoked_at = ? WHERE session_id = ? AND employee_id = ?")
      .bind(nowIso(), targetSid, auth.actor.id)
      .run();
    await writeAuditLog(env.DB, auth.actor, "REVOKE_OWN_SESSION", "session", targetSid, "device kicked by self");
    return json({ ok: true }, 200, cors);
  }

  return null;
}
