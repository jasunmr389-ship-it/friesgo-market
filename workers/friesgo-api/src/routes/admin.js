// Super-Admin & Manager Governance Routes:
// Employee lifecycle (create/disable/enable/reset password/device session revocation),
// Audit logs, Full logical backup/restore, and Mandatory Post-Restore Security Re-Verification.

import { parseQuotaCapStrict, requireAuth, sanitizeEmployeePublic, verifyEmployeeTotpOrRecovery } from "../auth.js";
import { hashPassword, randomId, validatePasswordStrength } from "../crypto.js";
import { json, monotonicCompliance, monotonicOptOut, nowIso, parseJsonBody, writeAuditLog } from "../utils.js";
import { recomputeCompanyDerivedState } from "./companies.js";

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

const TABLE_COLUMNS = {
  companies: new Set(["id","canonical_name","norm_name","aliases_json","country_en","city","address","website","website_domain","industry_type","buyer_type","product_summary","pool_stage","parent_company_id","google_place_id","compliance_status","dd_json","opt_out_status","opt_out_meta_json","stage","next_follow_date","cadence_step","cadence_label","note","last_event_summary_json","derived_contact_status","version","merged_into_id","deleted_at","created_by","updated_by","schema_version","created_at","updated_at"]),
  company_contacts: new Set(["id","company_id","name","role","email","email_verify_level","phone_e164","whatsapp_ok","source_type","verified_at","opt_out_flag","deleted_at","schema_version","created_at","updated_at"]),
  company_product_interests: new Set(["id","company_id","profile_key","buyer_type","fit_score","evidence_score","intent_level","total_score","score_breakdown_json","demand_note","schema_version","created_at","updated_at"]),
  raw_osm_pool: new Set(["id","osm_ref","country_en","city","name","category","raw_tags_json","collected_by","collected_at","promoted_company_id","license_tag","schema_version","created_at","updated_at"]),
  source_evidences: new Set(["id","company_id","field_scope","source_type","source_url","license_class","verified_by","verified_at","schema_version","created_at"]),
  contact_events: new Set(["event_id","company_id","contact_id","employee_id","employee_name","channel","action_outcome","summary","next_action","next_follow_date","occurred_at","schema_version","created_at"]),
  quote_records: new Set(["quote_id","company_id","ref_no","quote_tier","profile_version","payload_json","sent_confirmed","created_by","schema_version","created_at","updated_at"]),
  compliance_order_logs: new Set(["log_id","order_ref","company_id","decision","checks_json","reviewer","saved_at","schema_version","created_at"]),
  scrape_task_logs: new Set(["id","country_en","city","radius_km","keyword","profile_key","engine","employee_id","raw_count","verified_count","created_at"]),
  product_profiles: new Set(["profile_key","version","config_json","updated_by","updated_at"]),
  feedback_items: new Set(["id","employee_id","employee_name","category","content","sanitized_context_json","status","admin_reply","created_at","updated_at"]),
  migration_batches: new Set(["batch_id","employee_id","employee_name","summary_json","created_at"]),
};

async function setRestoreFreeze(db, frozen, meta = {}) {
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO system_maintenance_state (state_key, state_value, meta_json, updated_at)
       VALUES ('restore_freeze', ?, ?, ?)
       ON CONFLICT(state_key) DO UPDATE SET state_value = excluded.state_value, meta_json = excluded.meta_json, updated_at = excluded.updated_at`
    )
    .bind(frozen ? "1" : "0", JSON.stringify(meta), now)
    .run();
}

async function enforceSuperAdminTotp(env, actor, body, cors) {
  const code = body && (body.totp_code || body.admin_totp);
  const check = await verifyEmployeeTotpOrRecovery(env.DB, actor, code, env);
  if (!check.ok) {
    return json({ error: "高危管理操作必须校验总负责人 2FA 动态码：" + check.error, code: "ADMIN_TOTP_REQUIRED" }, 403, cors);
  }
  return null;
}

export async function handleAdminRoutes(request, env, cors, url) {
  const path = url.pathname;
  const method = request.method;

  // 1. List members
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

  // 2. Create member (super_admin + TOTP)
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
    const capParsed = parseQuotaCapStrict(body.gmaps_monthly_cap, 250);
    if (!capParsed.ok) return json({ error: capParsed.error }, 400, cors);
    const gmapsCap = capParsed.value;

    if (!/^[a-z0-9._-]{3,32}$/.test(loginId)) {
      return json({ error: "登录名须为 3–32 位小写字母、数字、点或下划线" }, 400, cors);
    }
    if (!displayName || displayName.length > 40) {
      return json({ error: "请填写 1–40 字的成员显示姓名" }, 400, cors);
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

  // 2b. Batch create members (super_admin + single TOTP 2FA verification for up to 20 members)
  if (path === "/api/admin/employees/batch" && method === "POST") {
    const auth = await requireAuth(request, env, cors, { roles: ["super_admin"] });
    if (!auth.ok) return auth.response;
    const body = await parseJsonBody(request, 65536);
    const totpErr = await enforceSuperAdminTotp(env, auth.actor, body, cors);
    if (totpErr) return totpErr;

    const rawList = Array.isArray(body.employees) ? body.employees : [];
    if (!rawList.length) {
      return json({ error: "请至少填写 1 位成员信息" }, 400, cors);
    }
    if (rawList.length > 20) {
      return json({ error: "单次批量最多开通 20 位成员账号" }, 400, cors);
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
      const capParsed = parseQuotaCapStrict(row.gmaps_monthly_cap, 250);
      if (!capParsed.ok) {
        errors.push(`第 ${rowNo} 行：${capParsed.error}`);
        continue;
      }
      const gmapsCap = capParsed.value;

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
        errors.push(`第 ${rowNo} 行：请填写 1–40 字的成员显示姓名`);
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

    const now = nowIso();
    const pendingRows = [];
    for (const item of prepared) {
      const hashed = await hashPassword(item.password, env.AUTH_PEPPER);
      const id = randomId("emp");
      pendingRows.push({
        id,
        stmt: env.DB
          .prepare(
            `INSERT INTO employees (id, login_id, display_name, role, status, pwd_hash, pwd_salt, pwd_iter, totp_secret_enc, totp_enabled, recovery_codes_hash_json, must_reset_pwd, gmaps_monthly_cap, schema_version, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'active', ?, ?, ?, '', 0, '[]', 1, ?, 1, ?, ?)`
          )
          .bind(id, item.loginId, item.displayName, item.role, hashed.hashHex, hashed.saltHex, hashed.iterations, item.gmapsCap, now, now),
      });
    }
    if (typeof env.DB.batch === "function") {
      await env.DB.batch(pendingRows.map((p) => p.stmt));
    } else {
      for (const p of pendingRows) await p.stmt.run();
    }
    const createdList = [];
    for (const p of pendingRows) {
      const created = await env.DB.prepare("SELECT * FROM employees WHERE id = ?").bind(p.id).first();
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

  // 3. Update member (disable / enable / reset password / change role / change quota cap)
  const empMatch = path.match(/^\/api\/admin\/employees\/([^/]+)$/);
  if (empMatch && method === "PATCH") {
    const auth = await requireAuth(request, env, cors, { roles: ["super_admin"] });
    if (!auth.ok) return auth.response;
    const targetId = decodeURIComponent(empMatch[1]);
    const body = await parseJsonBody(request, 16384);
    const totpErr = await enforceSuperAdminTotp(env, auth.actor, body, cors);
    if (totpErr) return totpErr;

    const target = await env.DB.prepare("SELECT * FROM employees WHERE id = ?").bind(targetId).first();
    if (!target) return json({ error: "成员账号不存在" }, 404, cors);
    if (target.id === auth.actor.id && body.status === "disabled") {
      return json({ error: "不能停用当前登录的总负责人账号" }, 400, cors);
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

    // D07: Preserve exact existing cap including 0! NEVER use `target.gmaps_monthly_cap || 250`!
    const existingCap = target.gmaps_monthly_cap === undefined || target.gmaps_monthly_cap === null
      ? 250
      : Number(target.gmaps_monthly_cap);
    let newCap = existingCap;
    if (body.gmaps_monthly_cap !== undefined && body.gmaps_monthly_cap !== null && body.gmaps_monthly_cap !== "") {
      const capParsed = parseQuotaCapStrict(body.gmaps_monthly_cap, existingCap);
      if (!capParsed.ok) return json({ error: capParsed.error }, 400, cors);
      newCap = capParsed.value;
      if (newCap !== existingCap) diffs.push(`gmaps_cap:${existingCap}->${newCap}`);
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
    const auth = await requireAuth(request, env, cors, { roles: ["super_admin", "manager"], allowDuringRestoreFreeze: true });
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
        backupVersion: "v2.1-m2a-backup-2",
        schemaVersion: 2,
        exportedAt: nowIso(),
        counts,
        employeesMeta: empSnap.results || [],
        tables,
      },
      200,
      cors
    );
  }

  // 7. Restore logical backup snapshot (D05/S02: freezes ALL business traffic, preserves latest monotonic opt-out & compliance blocked states, strict column allowlists)
  if (path === "/api/admin/restore-backup" && method === "POST") {
    const auth = await requireAuth(request, env, cors, { roles: ["super_admin"], allowDuringRestoreFreeze: true });
    if (!auth.ok) return auth.response;
    const body = await parseJsonBody(request, 5 * 1024 * 1024);
    const totpErr = await enforceSuperAdminTotp(env, auth.actor, body, cors);
    if (totpErr) return totpErr;
    if (body.confirmPhrase !== "RESTORE_CONFIRM") {
      return json({ error: "缺少明确恢复确认短语 RESTORE_CONFIRM" }, 400, cors);
    }

    const tables = body.tables || {};
    if (typeof tables !== "object" || Array.isArray(tables)) {
      return json({ error: "无效备份数据格式（缺少 tables 对象）" }, 400, cors);
    }

    // Step 1: IMMEDIATELY persist restore_freeze = 1 so ALL non-admin business calls fail-closed with 503 until post-restore-verify completes!
    await setRestoreFreeze(env.DB, true, { actor: auth.actor.display_name, startedAt: nowIso() });
    await env.DB.prepare("DELETE FROM contact_locks").run();

    // Step 2: Snapshot latest safety-critical monotonic protections BEFORE applying older snapshot (never resurrect opted-out or blocked companies!)
    const preProtectRows = await env.DB
      .prepare("SELECT id, opt_out_status, opt_out_meta_json, compliance_status, derived_contact_status FROM companies WHERE opt_out_status != 'none' OR compliance_status = 'blocked'")
      .all();
    const protectMap = new Map();
    for (const pr of preProtectRows.results || []) {
      protectMap.set(pr.id, pr);
    }

    const restoredCounts = {};
    const preservedProtections = [];

    for (const tbl of BACKUP_TABLES) {
      const allowedCols = TABLE_COLUMNS[tbl];
      const rows = Array.isArray(tables[tbl]) ? tables[tbl] : [];
      let inserted = 0;
      for (const rawRow of rows) {
        if (!rawRow || typeof rawRow !== "object") continue;
        const row = { ...rawRow };
        // Monotonic non-downgrade protection on companies during stale snapshot restore!
        if (tbl === "companies" && row.id && protectMap.has(row.id)) {
          const prev = protectMap.get(row.id);
          const mergedOpt = monotonicOptOut(prev.opt_out_status, row.opt_out_status);
          const mergedComp = monotonicCompliance(prev.compliance_status, row.compliance_status, false);
          if (mergedOpt !== row.opt_out_status || mergedComp !== row.compliance_status) {
            row.opt_out_status = mergedOpt;
            if (prev.opt_out_meta_json && prev.opt_out_meta_json !== "{}") {
              row.opt_out_meta_json = prev.opt_out_meta_json;
            }
            row.compliance_status = mergedComp;
            if (mergedOpt !== "none" || mergedComp === "blocked") {
              row.derived_contact_status = "stopped";
            }
            preservedProtections.push({ id: row.id, opt_out_status: mergedOpt, compliance_status: mergedComp });
          }
        }
        const cols = Object.keys(row).filter((c) => allowedCols && allowedCols.has(c));
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

    await writeAuditLog(
      env.DB,
      auth.actor,
      "RESTORE_BACKUP",
      "database",
      "d1",
      JSON.stringify({ restoredCounts, preservedProtectionCount: preservedProtections.length, restoreFrozen: true })
    );
    return json(
      {
        ok: true,
        restoreFrozen: true,
        restoredCounts,
        preservedProtections,
        nextStep: "恢复已完成，系统已自动进入业务冻结状态（503 SYSTEM_RESTORE_FROZEN），须立即执行「恢复后安全重核验」以复核权限、退订与会话并解除冻结！",
      },
      200,
      cors
    );
  }

  // 8. Mandatory Post-Restore Security Re-Verification Gate (D05: verifies per-ID protections, reconciles events, revokes old sessions, and lifts restore_freeze)
  if (path === "/api/admin/post-restore-verify" && method === "POST") {
    const auth = await requireAuth(request, env, cors, { roles: ["super_admin"], allowDuringRestoreFreeze: true });
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
    // Always revoke sessions of disabled members and clear all stale locks
    await env.DB
      .prepare("UPDATE sessions SET revoked_at = ? WHERE employee_id IN (SELECT id FROM employees WHERE status != 'active') AND revoked_at IS NULL")
      .bind(now)
      .run();
    await env.DB.prepare("DELETE FROM contact_locks WHERE expires_at <= ?").bind(now).run();

    // Reconcile any companies that have persisted unsubscribed/rejected events or opt-out flags so projection matches events 100%
    const suspectIds = await env.DB
      .prepare(
        `SELECT DISTINCT company_id AS id FROM contact_events WHERE action_outcome IN ('unsubscribed', 'rejected')
         UNION
         SELECT id FROM companies WHERE opt_out_status != 'none' OR compliance_status = 'blocked'`
      )
      .all();
    for (const r of suspectIds.results || []) {
      if (r && r.id) await recomputeCompanyDerivedState(env.DB, r.id);
    }

    const empStats = await env.DB
      .prepare("SELECT status, COUNT(*) AS cnt FROM employees GROUP BY status")
      .all();
    const disabledMemberIds = await env.DB
      .prepare("SELECT id, login_id FROM employees WHERE status = 'disabled' LIMIT 30")
      .all();
    const protectedSample = await env.DB
      .prepare("SELECT id, canonical_name, opt_out_status, compliance_status, derived_contact_status FROM companies WHERE opt_out_status != 'none' OR compliance_status = 'blocked' LIMIT 30")
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

    // Lift restore maintenance freeze ONLY after all checks, revocations & reconciliations succeed!
    await setRestoreFreeze(env.DB, false, { verifiedBy: auth.actor.display_name, verifiedAt: now });

    const report = {
      verifiedAt: now,
      restoreFreezeCleared: true,
      revokedOtherSessions: revokedSessionsCount,
      employeesByStatus: empStats.results || [],
      disabledMemberIds: (disabledMemberIds.results || []).map((e) => e.login_id),
      activeCompanies: Number((totalCompanies && totalCompanies.cnt) || 0),
      totalContactEvents: Number((totalEvents && totalEvents.cnt) || 0),
      totalQuotes: Number((totalQuotes && totalQuotes.cnt) || 0),
      totalComplianceLogs: Number((totalCompliance && totalCompliance.cnt) || 0),
      optOutProtectedCount: Number((optOutStats && optOutStats.cnt) || 0),
      complianceBlockedCount: Number((blockedStats && blockedStats.cnt) || 0),
      protectedSampleIds: (protectedSample.results || []).map((c) => ({
        id: c.id,
        opt_out_status: c.opt_out_status,
        compliance_status: c.compliance_status,
        derived_contact_status: c.derived_contact_status,
      })),
    };
    await writeAuditLog(env.DB, auth.actor, "POST_RESTORE_SECURITY_VERIFY", "database", "d1", JSON.stringify(report));
    return json({ ok: true, report }, 200, cors);
  }

  return null;
}
