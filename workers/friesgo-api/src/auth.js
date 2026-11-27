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
import { buildOtpAuthUri, generateTotpSecret, verifyTotpCode } from "./totp.js";
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

export function sanitizeEmployeePublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    login_id: row.login_id,
    display_name: row.display_name,
    role: row.role,
    status: row.status,
    totp_enabled: Boolean(row.totp_enabled),
    must_reset_pwd: Boolean(row.must_reset_pwd),
    gmaps_monthly_cap: Number(row.gmaps_monthly_cap || 250),
    created_at: row.created_at,
    updated_at: row.updated_at,
    disabled_at: row.disabled_at || null,
  };
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

export async function verifyEmployeeTotpOrRecovery(db, employeeRow, code, env) {
  const cleanCode = String(code || "").trim();
  if (!cleanCode) return { ok: false, error: "请输入 6 位动态验证码或一次性应急恢复码" };
  if (!employeeRow.totp_secret_enc) {
    return { ok: false, error: "当前账号尚未完成 2FA 密钥绑定" };
  }
  const secretBase32 = await decryptSecret(employeeRow.totp_secret_enc, env.TOTP_ENC_KEY);
  const totpOk = await verifyTotpCode(secretBase32, cleanCode);
  if (totpOk) return { ok: true, usedRecovery: false };

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
 * - revoked session or disabled employee -> immediate 401 SESSION_REVOKED_OR_DISABLED
 * - super_admin without totp_enabled=1 -> restricted to TOTP enrollment routes only
 */
export async function requireAuth(request, env, cors, opts = {}) {
  const authHeader = request.headers.get("Authorization") || "";
  const m = authHeader.match(/^Bearer\s+(\S+)$/i);
  if (!m) {
    return {
      ok: false,
      response: json({ error: "需要员工身份认证后方可访问", code: "AUTH_REQUIRED" }, 401, cors),
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

  // Mandatory 2FA gate for super_admin on all business/admin endpoints
  if (row.role === "super_admin" && !row.totp_enabled && !opts.allowPendingTotpSetup) {
    return {
      ok: false,
      response: json(
        {
          error: "最高管理员账号必须先完成双重身份验证（2FA）绑定后方可使用系统",
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

    // Super-admin mandatory 2FA enforcement
    if (emp.role === "super_admin" && emp.totp_enabled) {
      if (!totpCode) {
        return json(
          { ok: false, requireTotp: true, message: "最高管理员账号请输入 6 位 TOTP 动态验证码（或一次性恢复码）" },
          200,
          cors
        );
      }
      const totpRes = await verifyEmployeeTotpOrRecovery(env.DB, emp, totpCode, env);
      if (!totpRes.ok) {
        await recordLoginFailure(env.DB, bucketKey);
        return json({ error: totpRes.error, code: "INVALID_TOTP", requireTotp: true }, 401, cors);
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
    const auth = await requireAuth(request, env, cors, { allowPendingTotpSetup: true });
    if (!auth.ok) return auth.response;
    return json(
      {
        ok: true,
        sessionId: auth.sessionId,
        requireTotpSetup: auth.actor.role === "super_admin" && !auth.actor.totp_enabled,
        employee: sanitizeEmployeePublic(auth.actor),
      },
      200,
      cors
    );
  }

  // 6. Logout (revoke current device session)
  if (path === "/api/auth/logout" && method === "POST") {
    const auth = await requireAuth(request, env, cors, { allowPendingTotpSetup: true });
    if (!auth.ok) return auth.response;
    await env.DB
      .prepare("UPDATE sessions SET revoked_at = ? WHERE session_id = ?")
      .bind(nowIso(), auth.sessionId)
      .run();
    await writeAuditLog(env.DB, auth.actor, "LOGOUT", "session", auth.sessionId, "self logout");
    return json({ ok: true }, 200, cors);
  }

  // 7. Self password change (revokes other sessions so stolen tokens die)
  if (path === "/api/auth/change-password" && method === "POST") {
    const auth = await requireAuth(request, env, cors);
    if (!auth.ok) return auth.response;
    const body = await parseJsonBody(request, 8192);
    const oldPwd = String(body.old_password || "");
    const newPwd = String(body.new_password || "");
    const empFull = await env.DB.prepare("SELECT * FROM employees WHERE id = ?").bind(auth.actor.id).first();
    const okOld = await verifyPassword(oldPwd, env.AUTH_PEPPER, empFull.pwd_salt, empFull.pwd_hash, empFull.pwd_iter);
    if (!okOld) return json({ error: "原密码不正确" }, 400, cors);
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
