// Super-Admin & Manager Governance Routes:
// Employee lifecycle (create/disable/enable/reset password/device session revocation),
// Audit logs, Full logical backup/restore, and Mandatory Post-Restore Security Re-Verification.

import { requireAuth, sanitizeEmployeePublic, verifyEmployeeTotpOrRecovery } from "../auth.js";
import { hashPassword, randomId, validatePasswordStrength } from "../crypto.js";
import { json, nowIso, parseJsonBody, writeAuditLog } from "../utils.js";

const BACKUP_TABLES = [
  "companies",
  "company_contacts",
  "company_product_interests",
  "raw_osm_pool",
  "source_evidences",
  "contact_events",
  "quote_records",
  "compliance_order_logs",
  "scrape_task_logs",
  "product_profiles",
  "feedback_items",
  "migration_batches",
];

async function enforceSuperAdminTotp(env, actor, body, cors) {
  const code = body && (body.totp_code || body.admin_totp);
  const check = await verifyEmployeeTotpOrRecovery(env.DB, actor, code, env);
  if (!check.ok) {
    return json({ error: "高危管理操作必须校验最高管理员 2FA 动态码：" + check.error, code: "ADMIN_TOTP_REQUIRED" }, 403, cors);
  }
  return null;
}

export async function handleAdminRoutes(request, env, cors, url) {
  const path = url.pathname;
  const method = request.method;

  // 1. List employees
  if (path === "/api/admin/employees" && method === "GET") {
    const auth = await requireAuth(request, env, cors, { roles: ["super_admin", "manager"] });
    if (!auth.ok) return auth.response;
    const rows = await env.DB
      .prepare(
        `SELECT e.id, e.login_id, e.display_name, e.role, e.status, e.totp_enabled, e.must_reset_pwd,
                e.gmaps_monthly_cap, e.created_at, e.updated_at, e.disabled_at,
                (SELECT COUNT(*) FROM sessions s WHERE s.employee_id = e.id AND s.revoked_at IS NULL AND s.expires_at > ?) AS active_sessions
         FROM employees e
         ORDER BY CASE e.role WHEN 'super_admin' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, e.created_at ASC`
      )
      .bind(nowIso())
      .all();
    return json({ ok: true, employees: rows.results || [] }, 200, cors);
  }

  // 2. Create employee (super_admin + TOTP)
  if (path === "/api/admin/employees" && method === "POST") {
    const auth = await requireAuth(request, env, cors, { roles: ["super_admin"] });
    if (!auth.ok) return auth.response;
    const body = await parseJsonBody(request, 16384);
    const totpErr = await enforceSuperAdminTotp(env, auth.actor, body, cors);
    if (totpErr) return totpErr;

    const loginId = String(body.login_id || "").trim().toLowerCase();
    const displayName = String(body.display_name || "").trim();
    const role = body.role === "manager" ? "manager" : "staff";
    const password = String(body.password || "");
    const gmapsCap = Math.min(950, Math.max(0, parseInt(body.gmaps_monthly_cap ?? 250, 10) || 250));

    if (!/^[a-z0-9._-]{3,32}$/.test(loginId)) {
      return json({ error: "登录名须为 3–32 位小写字母、数字、点或下划线" }, 400, cors);
    }
    if (!displayName || displayName.length > 40) {
      return json({ error: "请填写 1–40 字的员工显示姓名" }, 400, cors);
    }
    const pwCheck = validatePasswordStrength(password);
    if (!pwCheck.ok) return json({ error: pwCheck.error }, 400, cors);

    const dup = await env.DB.prepare("SELECT id FROM employees WHERE login_id = ?").bind(loginId).first();
    if (dup) return json({ error: "该登录名已存在，请更换" }, 409, cors);

    const hashed = await hashPassword(password, env.AUTH_PEPPER);
    const id = randomId("emp");
    const now = nowIso();
    await env.DB
      .prepare(
        `INSERT INTO employees (id, login_id, display_name, role, status, pwd_hash, pwd_salt, pwd_iter, totp_secret_enc, totp_enabled, recovery_codes_hash_json, must_reset_pwd, gmaps_monthly_cap, schema_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, '', 0, '[]', 1, ?, 1, ?, ?)`
      )
      .bind(id, loginId, displayName, role, hashed.hashHex, hashed.saltHex, hashed.iterations, gmapsCap, now, now)
      .run();

    await writeAuditLog(env.DB, auth.actor, "CREATE_EMPLOYEE", "employee", id, `login_id=${loginId}, role=${role}, cap=${gmapsCap}`);
    const created = await env.DB.prepare("SELECT * FROM employees WHERE id = ?").bind(id).first();
    return json({ ok: true, employee: sanitizeEmployeePublic(created) }, 201, cors);
  }

  // 2b. Batch create employees (super_admin + single TOTP 2FA verification for up to 20 staff)
  if (path === "/api/admin/employees/batch" && method === "POST") {
    const auth = await requireAuth(request, env, cors, { roles: ["super_admin"] });
    if (!auth.ok) return auth.response;
    const body = await parseJsonBody(request, 65536);
    const totpErr = await enforceSuperAdminTotp(env, auth.actor, body, cors);
    if (totpErr) return totpErr;

    const rawList = Array.isArray(body.employees) ? body.employees : [];
    if (!rawList.length) {
      return json({ error: "请至少填写 1 位员工信息" }, 400, cors);
    }
    if (rawList.length > 20) {
      return json({ error: "单次批量最多开通 20 位员工账号" }, 400, cors);
    }

    const prepared = [];
    const seenLogin = new Set();
    const errors = [];
    for (let i = 0; i < rawList.length; i++) {
      const row = rawList[i] || {};
      const rowNo = i + 1;
      const loginId = String(row.login_id || "").trim().toLowerCase();
      const displayName = String(row.display_name || "").trim();
      const role = row.role === "manager" ? "manager" : "staff";
      const password = String(row.password || "");
      const gmapsCap = Math.min(950, Math.max(0, parseInt(row.gmaps_monthly_cap ?? 250, 10) || 250));

      if (!/^[a-z0-9._-]{3,32}$/.test(loginId)) {
        errors.push(`第 ${rowNo} 行：登录名须为 3–32 位小写字母、数字、点或下划线`);
        continue;
      }
      if (seenLogin.has(loginId)) {
        errors.push(`第 ${rowNo} 行：登录名「${loginId}」在本次列表中重复`);
        continue;
      }
      seenLogin.add(loginId);
      if (!displayName || displayName.length > 40) {
        errors.push(`第 ${rowNo} 行：请填写 1–40 字的员工显示姓名`);
        continue;
      }
      const pwCheck = validatePasswordStrength(password);
      if (!pwCheck.ok) {
        errors.push(`第 ${rowNo} 行（${displayName}）：${pwCheck.error}`);
        continue;
      }
      const dup = await env.DB.prepare("SELECT id FROM employees WHERE login_id = ?").bind(loginId).first();
      if (dup) {
        errors.push(`第 ${rowNo} 行：登录名「${loginId}」已存在`);
        continue;
      }
      prepared.push({ loginId, displayName, role, password, gmapsCap });
    }

    if (errors.length) {
      return json({ error: errors.join("；"), errors }, 400, cors);
    }

    const createdList = [];
    const now = nowIso();
    for (const item of prepared) {
      const hashed = await hashPassword(item.password, env.AUTH_PEPPER);
      const id = randomId("emp");
      await env.DB
        .prepare(
          `INSERT INTO employees (id, login_id, display_name, role, status, pwd_hash, pwd_salt, pwd_iter, totp_secret_enc, totp_enabled, recovery_codes_hash_json, must_reset_pwd, gmaps_monthly_cap, schema_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?, '', 0, '[]', 1, ?, 1, ?, ?)`
        )
        .bind(id, item.loginId, item.displayName, item.role, hashed.hashHex, hashed.saltHex, hashed.iterations, item.gmapsCap, now, now)
        .run();
      const created = await env.DB.prepare("SELECT * FROM employees WHERE id = ?").bind(id).first();
      createdList.push(sanitizeEmployeePublic(created));
    }

    await writeAuditLog(
      env.DB,
      auth.actor,
      "BATCH_CREATE_EMPLOYEES",
      "employee",
      "batch",
      `count=${createdList.length}, logins=${createdList.map((e) => e.login_id).join(",")}`
    );
    return json({ ok: true, count: createdList.length, employees: createdList }, 201, cors);
  }

  // 3. Update employee (disable / enable / reset password / change role / change quota cap)
  const empMatch = path.match(/^\/api\/admin\/employees\/([^/]+)$/);
  if (empMatch && method === "PATCH") {
    const auth = await requireAuth(request, env, cors, { roles: ["super_admin"] });
    if (!auth.ok) return auth.response;
    const targetId = decodeURIComponent(empMatch[1]);
    const body = await parseJsonBody(request, 16384);
    const totpErr = await enforceSuperAdminTotp(env, auth.actor, body, cors);
    if (totpErr) return totpErr;

    const target = await env.DB.prepare("SELECT * FROM employees WHERE id = ?").bind(targetId).first();
    if (!target) return json({ error: "员工账号不存在" }, 404, cors);
    if (target.id === auth.actor.id && body.status === "disabled") {
      return json({ error: "不能停用当前登录的最高管理员账号" }, 400, cors);
    }

    const now = nowIso();
    const diffs = [];
    let newStatus = target.status;
    let disabledAt = target.disabled_at;
    if (body.status === "disabled" || body.status === "active") {
      newStatus = body.status;
      disabledAt = newStatus === "disabled" ? now : null;
      diffs.push(`status:${target.status}->${newStatus}`);
    }

    let newRole = target.role;
    if (target.role !== "super_admin" && (body.role === "manager" || body.role === "staff")) {
      newRole = body.role;
      if (newRole !== target.role) diffs.push(`role:${target.role}->${newRole}`);
    }

    let newName = target.display_name;
    if (typeof body.display_name === "string" && body.display_name.trim()) {
      newName = body.display_name.trim().slice(0, 40);
      if (newName !== target.display_name) diffs.push(`name:${target.display_name}->${newName}`);
    }

    let newCap = Number(target.gmaps_monthly_cap || 250);
    if (body.gmaps_monthly_cap != null) {
      newCap = Math.min(950, Math.max(0, parseInt(body.gmaps_monthly_cap, 10) || 0));
      diffs.push(`gmaps_cap:${target.gmaps_monthly_cap}->${newCap}`);
    }

    let pwdHash = target.pwd_hash;
    let pwdSalt = target.pwd_salt;
    let pwdIter = target.pwd_iter;
    let mustReset = target.must_reset_pwd;
    let revokeAll = newStatus === "disabled";

    if (typeof body.reset_password === "string" && body.reset_password.length > 0) {
      const pwCheck = validatePasswordStrength(body.reset_password);
      if (!pwCheck.ok) return json({ error: pwCheck.error }, 400, cors);
      const hashed = await hashPassword(body.reset_password, env.AUTH_PEPPER);
      pwdHash = hashed.hashHex;
      pwdSalt = hashed.saltHex;
      pwdIter = hashed.iterations;
      mustReset = 1;
      revokeAll = true;
      diffs.push("password_reset+sessions_revoked");
    }

    await env.DB
      .prepare(
        `UPDATE employees
         SET display_name = ?, role = ?, status = ?, pwd_hash = ?, pwd_salt = ?, pwd_iter = ?,
             must_reset_pwd = ?, gmaps_monthly_cap = ?, disabled_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(newName, newRole, newStatus, pwdHash, pwdSalt, pwdIter, mustReset, newCap, disabledAt, now, targetId)
      .run();

    if (revokeAll) {
      await env.DB
        .prepare("UPDATE sessions SET revoked_at = ? WHERE employee_id = ? AND revoked_at IS NULL")
        .bind(now, targetId)
        .run();
      // Also release any active short-term contact locks held by disabled employee
      if (newStatus === "disabled") {
        await env.DB.prepare("DELETE FROM contact_locks WHERE employee_id = ?").bind(targetId).run();
      }
    }

    await writeAuditLog(env.DB, auth.actor, "UPDATE_EMPLOYEE", "employee", targetId, diffs.join("; ") || "no_change");
    const updated = await env.DB.prepare("SELECT * FROM employees WHERE id = ?").bind(targetId).first();
    return json({ ok: true, employee: sanitizeEmployeePublic(updated), sessionsRevoked: revokeAll }, 200, cors);
  }

  // 4. List or revoke employee device sessions (super_admin + TOTP)
  const empSesMatch = path.match(/^\/api\/admin\/employees\/([^/]+)\/sessions$/);
  if (empSesMatch && method === "GET") {
    const auth = await requireAuth(request, env, cors, { roles: ["super_admin"] });
    if (!auth.ok) return auth.response;
    const targetId = decodeURIComponent(empSesMatch[1]);
    const rows = await env.DB
      .prepare(
        "SELECT session_id, device_label, ua_fingerprint, expires_at, revoked_at, last_seen_at, created_at FROM sessions WHERE employee_id = ? ORDER BY created_at DESC LIMIT 30"
      )
      .bind(targetId)
      .all();
    return json({ ok: true, sessions: rows.results || [] }, 200, cors);
  }

  const empRevMatch = path.match(/^\/api\/admin\/employees\/([^/]+)\/revoke-sessions$/);
  if (empRevMatch && method === "POST") {
    const auth = await requireAuth(request, env, cors, { roles: ["super_admin"] });
    if (!auth.ok) return auth.response;
    const targetId = decodeURIComponent(empRevMatch[1]);
    const body = await parseJsonBody(request, 8192);
    const totpErr = await enforceSuperAdminTotp(env, auth.actor, body, cors);
    if (totpErr) return totpErr;

    const now = nowIso();
    const singleSid = String(body.session_id || "").trim();
    if (singleSid) {
      await env.DB
        .prepare("UPDATE sessions SET revoked_at = ? WHERE session_id = ? AND employee_id = ?")
        .bind(now, singleSid, targetId)
        .run();
      await writeAuditLog(env.DB, auth.actor, "REVOKE_EMPLOYEE_SESSION", "session", singleSid, `employee_id=${targetId}`);
    } else {
      await env.DB
        .prepare("UPDATE sessions SET revoked_at = ? WHERE employee_id = ? AND revoked_at IS NULL")
        .bind(now, targetId)
        .run();
      await writeAuditLog(env.DB, auth.actor, "REVOKE_ALL_EMPLOYEE_SESSIONS", "employee", targetId, "all active devices revoked");
    }
    return json({ ok: true }, 200, cors);
  }

  // 5. Audit logs
  if (path === "/api/admin/audit-logs" && method === "GET") {
    const auth = await requireAuth(request, env, cors, { roles: ["super_admin", "manager"] });
    if (!auth.ok) return auth.response;
    const limit = Math.min(100, Math.max(10, parseInt(url.searchParams.get("limit") || "50", 10) || 50));
    const rows = await env.DB
      .prepare("SELECT id, actor_id, actor_name, action, target_type, target_id, diff_summary, created_at FROM audit_logs ORDER BY created_at DESC LIMIT ?")
      .bind(limit)
      .all();
    return json({ ok: true, logs: rows.results || [] }, 200, cors);
  }

  // 6. Export logical company backup snapshot (super_admin + TOTP; excludes password hashes & TOTP secrets)
  if (path === "/api/admin/export-backup" && method === "POST") {
    const auth = await requireAuth(request, env, cors, { roles: ["super_admin"] });
    if (!auth.ok) return auth.response;
    const body = await parseJsonBody(request, 8192);
    const totpErr = await enforceSuperAdminTotp(env, auth.actor, body, cors);
    if (totpErr) return totpErr;

    const tables = {};
    const counts = {};
    for (const tbl of BACKUP_TABLES) {
      const r = await env.DB.prepare(`SELECT * FROM ${tbl}`).all();
      tables[tbl] = r.results || [];
      counts[tbl] = tables[tbl].length;
    }
    const empSnap = await env.DB
      .prepare("SELECT id, login_id, display_name, role, status, totp_enabled, disabled_at FROM employees")
      .all();
    await writeAuditLog(env.DB, auth.actor, "EXPORT_BACKUP", "database", "d1", JSON.stringify(counts));
    return json(
      {
        ok: true,
        backupVersion: "v2.1-m2a-backup-1",
        exportedAt: nowIso(),
        counts,
        employeesMeta: empSnap.results || [],
        tables,
      },
      200,
      cors
    );
  }

  // 7. Restore logical backup snapshot (super_admin + TOTP + explicit confirmation)
  if (path === "/api/admin/restore-backup" && method === "POST") {
    const auth = await requireAuth(request, env, cors, { roles: ["super_admin"] });
    if (!auth.ok) return auth.response;
    const body = await parseJsonBody(request, 5 * 1024 * 1024);
    const totpErr = await enforceSuperAdminTotp(env, auth.actor, body, cors);
    if (totpErr) return totpErr;
    if (body.confirmPhrase !== "RESTORE_CONFIRM") {
      return json({ error: "缺少明确恢复确认短语 RESTORE_CONFIRM" }, 400, cors);
    }
    const tables = body.tables || {};
    const restoredCounts = {};

    for (const tbl of BACKUP_TABLES) {
      const rows = Array.isArray(tables[tbl]) ? tables[tbl] : [];
      let inserted = 0;
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const cols = Object.keys(row).filter((c) => /^[a-z0-9_]+$/i.test(c));
        if (!cols.length) continue;
        const placeholders = cols.map(() => "?").join(", ");
        const vals = cols.map((c) => (row[c] === undefined ? null : row[c]));
        await env.DB
          .prepare(`INSERT OR REPLACE INTO ${tbl} (${cols.join(", ")}) VALUES (${placeholders})`)
          .bind(...vals)
          .run();
        inserted++;
      }
      restoredCounts[tbl] = inserted;
    }

    await writeAuditLog(env.DB, auth.actor, "RESTORE_BACKUP", "database", "d1", JSON.stringify(restoredCounts));
    return json(
      {
        ok: true,
        restoredCounts,
        nextStep: "恢复已完成，开放业务访问前必须立即调用 POST /api/admin/post-restore-verify 完成权限、会话、退订与合规重核验！",
      },
      200,
      cors
    );
  }

  // 8. Mandatory Post-Restore Security Re-Verification Gate (Spec Section 7.1 #4)
  if (path === "/api/admin/post-restore-verify" && method === "POST") {
    const auth = await requireAuth(request, env, cors, { roles: ["super_admin"] });
    if (!auth.ok) return auth.response;
    const body = await parseJsonBody(request, 8192);
    const totpErr = await enforceSuperAdminTotp(env, auth.actor, body, cors);
    if (totpErr) return totpErr;

    const now = nowIso();
    let revokedSessionsCount = 0;
    if (body.revokeOtherSessions !== false) {
      const res = await env.DB
        .prepare("UPDATE sessions SET revoked_at = ? WHERE session_id != ? AND revoked_at IS NULL")
        .bind(now, auth.sessionId)
        .run();
      revokedSessionsCount = Number((res && res.meta && res.meta.changes) || 0);
    }
    // Always revoke sessions of disabled employees and clear stale locks
    await env.DB
      .prepare("UPDATE sessions SET revoked_at = ? WHERE employee_id IN (SELECT id FROM employees WHERE status != 'active') AND revoked_at IS NULL")
      .bind(now)
      .run();
    await env.DB.prepare("DELETE FROM contact_locks WHERE expires_at <= ?").bind(now).run();

    const empStats = await env.DB
      .prepare("SELECT status, COUNT(*) AS cnt FROM employees GROUP BY status")
      .all();
    const optOutStats = await env.DB
      .prepare("SELECT COUNT(*) AS cnt FROM companies WHERE opt_out_status != 'none'")
      .first();
    const blockedStats = await env.DB
      .prepare("SELECT COUNT(*) AS cnt FROM companies WHERE compliance_status = 'blocked'")
      .first();
    const totalCompanies = await env.DB
      .prepare("SELECT COUNT(*) AS cnt FROM companies WHERE deleted_at IS NULL AND merged_into_id IS NULL")
      .first();
    const totalEvents = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM contact_events").first();
    const totalQuotes = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM quote_records").first();
    const totalCompliance = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM compliance_order_logs").first();

    const report = {
      verifiedAt: now,
      revokedOtherSessions: revokedSessionsCount,
      employeesByStatus: empStats.results || [],
      activeCompanies: Number((totalCompanies && totalCompanies.cnt) || 0),
      totalContactEvents: Number((totalEvents && totalEvents.cnt) || 0),
      totalQuotes: Number((totalQuotes && totalQuotes.cnt) || 0),
      totalComplianceLogs: Number((totalCompliance && totalCompliance.cnt) || 0),
      optOutProtectedCount: Number((optOutStats && optOutStats.cnt) || 0),
      complianceBlockedCount: Number((blockedStats && blockedStats.cnt) || 0),
    };
    await writeAuditLog(env.DB, auth.actor, "POST_RESTORE_SECURITY_VERIFY", "database", "d1", JSON.stringify(report));
    return json({ ok: true, report }, 200, cors);
  }

  return null;
}
