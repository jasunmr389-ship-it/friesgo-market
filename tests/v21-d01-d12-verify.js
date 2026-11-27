#!/usr/bin/env node
/**
 * FriesGo Global V2.1 Directed Verification Suite (D01-D12, S01-S14, Naming Plan A)
 * Zero external npm deps: runs real Headless Chrome (1440px, 390px & exact 360px)
 * against real index.html + js/fg-core.js + js/fg-store.js + js/fg-cloud.js + js/fg-cloud-ui.js
 * and real Cloudflare Worker (workers/friesgo-api/src/index.js) backed by real Node SQLite.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import worker from "../workers/friesgo-api/src/index.js";
import { generateTotpCode } from "../workers/friesgo-api/src/totp.js";
import { findChrome } from "./_chrome.cjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SCHEMA_SQL = fs.readFileSync(path.join(ROOT, "workers", "friesgo-api", "migrations", "0001_init.sql"), "utf8");
const CHROME_BIN = findChrome();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function createSqliteD1() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(SCHEMA_SQL);
  function wrapStmt(sql, params = []) {
    return {
      bind(...args) {
        return wrapStmt(sql, args);
      },
      async first() {
        const row = raw.prepare(sql).get(...params);
        return row === undefined ? null : { ...row };
      },
      async all() {
        const rows = raw.prepare(sql).all(...params);
        return { results: rows.map((r) => ({ ...r })), success: true };
      },
      async run() {
        const info = raw.prepare(sql).run(...params);
        return { success: true, meta: { changes: Number(info.changes || 0) } };
      },
    };
  }
  return {
    raw,
    prepare: (sql) => wrapStmt(sql, []),
    async batch(stmts) {
      raw.exec("BEGIN IMMEDIATE");
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        raw.exec("COMMIT");
        return out;
      } catch (err) {
        try { raw.exec("ROLLBACK"); } catch (_) {}
        throw err;
      }
    },
  };
}

function startStaticServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const clean = (req.url || "/").split("?")[0];
      const rel = clean === "/" ? "index.html" : clean.replace(/^\/+/, "");
      const fp = path.join(ROOT, rel);
      if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
      fs.createReadStream(fp).pipe(res);
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}

function startWorkerServer(env) {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const ch of req) chunks.push(ch);
      const rawBody = Buffer.concat(chunks);
      const url = `http://127.0.0.1:${srv.address().port}${req.url}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) headers.set(k, v.join(", "));
        else if (v != null) headers.set(k, String(v));
      }
      const wReq = new Request(url, {
        method: req.method,
        headers,
        body: ["GET", "HEAD", "OPTIONS"].includes(req.method) ? undefined : rawBody,
      });
      const wRes = await worker.fetch(wReq, env);
      const outHdrs = {};
      wRes.headers.forEach((v, k) => {
        outHdrs[k] = v;
      });
      res.writeHead(wRes.status, outHdrs);
      res.end(Buffer.from(await wRes.arrayBuffer()));
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}

async function apiReq(apiUrl, method, p, { token, body, headers = {} } = {}) {
  const hdrs = { Origin: "http://127.0.0.1", ...headers };
  if (token) hdrs.Authorization = `Bearer ${token}`;
  if (body !== undefined) hdrs["Content-Type"] = "application/json";
  const r = await fetch(`${apiUrl}${p}`, {
    method,
    headers: hdrs,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { rawText: text }; }
  return { status: r.status, json };
}

async function launchChrome() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-d01d12-chrome-"));
  const chrome = spawn(
    CHROME_BIN,
    ["--headless=new", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${userDataDir}`, "about:blank"],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = "";
    chrome.stderr.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) resolve(m[1]);
    });
    setTimeout(() => reject(new Error("Chrome startup timeout")), 12000);
  });
  const infoPort = wsUrl.match(/:(\d+)\//)[1];
  const targets = await (await fetch(`http://127.0.0.1:${infoPort}/json`)).json();
  const pageWs = targets.find((t) => t.type === "page").webSocketDebuggerUrl;
  const ws = new WebSocket(pageWs);
  await new Promise((r) => ws.addEventListener("open", r));
  let seq = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    }
    if (msg.method === "Runtime.exceptionThrown") {
      pageErrors.push(msg.params.exceptionDetails.text + " " + (msg.params.exceptionDetails.exception?.description || ""));
    }
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, { resolve: res, reject: rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || ""));
    }
    return r.result.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  return { chrome, ws, send, evalJs, pageErrors, userDataDir };
}

(async () => {
  const db = createSqliteD1();
  const BOOT = "d01_d12_bootstrap_secret_1234567890";
  const env = {
    DB: db,
    ENVIRONMENT: "staging",
    ALLOWED_ORIGINS: "http://127.0.0.1,http://localhost",
    AUTH_PEPPER: "d01_d12_pepper_32_chars_min_1234567890",
    TOTP_ENC_KEY: Buffer.alloc(32, 5).toString("base64"),
    BOOTSTRAP_SECRET: BOOT,
    LOCK_TTL_SECONDS: "600",
    SESSION_TTL_DAYS: "30",
    GMAPS_TEAM_MONTHLY_CAP: "950",
    GMAPS_EMP_MONTHLY_CAP: "250",
  };
  const { srv: staticSrv, port: staticPort } = await startStaticServer();
  const { srv: apiSrv, port: apiPort } = await startWorkerServer(env);
  const apiUrl = `http://127.0.0.1:${apiPort}`;

  // ===== BACKEND DIRECTED CHECKS (D03, D04/S08, D05/S02, D06, D07/S14, D08/S08, S10) =====
  // 1. Health endpoint version & schemaVersion (S10)
  const h0 = await apiReq(apiUrl, "GET", "/api/health");
  assert.equal(h0.status, 200);
  assert.equal(h0.json.version, "v2.1-m2a");
  assert.equal(h0.json.schemaVersion, 2);
  assert.equal(h0.json.restoreFrozen, false);
  assert.equal(h0.json.bootstrapped, false);
  console.log("PASS B1 (S10): /api/health reports version=v2.1-m2a, schemaVersion=2, restoreFrozen=false, bootstrapped=false");

  // 2. Bootstrap super_admin & enroll 2FA
  const boot = await apiReq(apiUrl, "POST", "/api/auth/bootstrap", {
    headers: { "X-Bootstrap-Secret": BOOT },
    body: { login_id: "boss", display_name: "林总负责人", password: "BossPassword123" },
  });
  assert.equal(boot.status, 201);
  const bossInitLogin = await apiReq(apiUrl, "POST", "/api/auth/login", {
    body: { login_id: "boss", password: "BossPassword123" },
  });
  assert.equal(bossInitLogin.status, 200);
  const bossSetup = await apiReq(apiUrl, "POST", "/api/auth/totp/setup", { token: bossInitLogin.json.token });
  const totpSecret = bossSetup.json.secretBase32;
  const codeNow = await generateTotpCode(totpSecret);
  const bossConfirm = await apiReq(apiUrl, "POST", "/api/auth/totp/confirm", {
    token: bossInitLogin.json.token,
    body: { totp_code: codeNow },
  });
  assert.equal(bossConfirm.status, 200);
  const bossToken = bossInitLogin.json.token;

  // 3. D04 / S08: Login TOTP single-use replay rejection
  const loginCode1 = await generateTotpCode(totpSecret);
  const loginOk = await apiReq(apiUrl, "POST", "/api/auth/login", {
    body: { login_id: "boss", password: "BossPassword123", totp_code: loginCode1 },
  });
  assert.equal(loginOk.status, 200);
  const loginReplay = await apiReq(apiUrl, "POST", "/api/auth/login", {
    body: { login_id: "boss", password: "BossPassword123", totp_code: loginCode1 },
  });
  assert.equal(loginReplay.status, 401);
  assert.equal(loginReplay.json.code, "TOTP_REPLAY_REJECTED");
  console.log("PASS B2 (D04/S08): Same-window TOTP login replay strictly rejected with 401 TOTP_REPLAY_REJECTED");

  // 4. D03: Batch employee creation atomic all-or-nothing (1 bad row cancels whole batch)
  const adminCode = await generateTotpCode(totpSecret);
  const badBatch = await apiReq(apiUrl, "POST", "/api/admin/employees/batch", {
    token: bossToken,
    body: {
      totp_code: adminCode,
      employees: [
        { login_id: "gooduser1", display_name: "有效成员1", password: "GoodPass123", role: "staff", gmaps_monthly_cap: 100 },
        { login_id: "bad user!", display_name: "非法登录名", password: "short", role: "staff", gmaps_monthly_cap: 0 },
      ],
    },
  });
  assert.equal(badBatch.status, 400);
  const afterBadBatch = await apiReq(apiUrl, "GET", "/api/admin/employees", { token: bossToken });
  assert.equal(afterBadBatch.json.employees.some((e) => e.login_id === "gooduser1"), false, "Failed batch must commit 0 rows");

  // Valid batch with explicit gmaps_monthly_cap: 0 (D07)
  const goodBatch = await apiReq(apiUrl, "POST", "/api/admin/employees/batch", {
    token: bossToken,
    body: {
      totp_code: adminCode,
      employees: [
        { login_id: "member_a", display_name: "余佳林", password: "MemberPass123", role: "staff", gmaps_monthly_cap: 200 },
        { login_id: "member_zero", display_name: "零额度成员", password: "MemberPass456", role: "staff", gmaps_monthly_cap: 0 },
      ],
    },
  });
  assert.equal(goodBatch.status, 201);
  const zeroEmp = goodBatch.json.employees.find((e) => e.login_id === "member_zero");
  assert.equal(zeroEmp.gmaps_monthly_cap, 0, "gmaps_monthly_cap=0 must be persisted as 0, never defaulted to 250");
  console.log("PASS B3 (D03/D07): Atomic batch employee creation & strict gmaps_monthly_cap=0 persistence verified");

  // 5. D07 / S14: Member with cap=0 gets 403 EMP_QUOTA_DISABLED & GET /api/gmaps/quota returns exact 0/0
  const zeroLogin = await apiReq(apiUrl, "POST", "/api/auth/login", {
    body: { login_id: "member_zero", password: "MemberPass456" },
  });
  assert.equal(zeroLogin.status, 200);
  assert.equal(zeroLogin.json.employee.must_reset_pwd, true);
  const qZero = await apiReq(apiUrl, "GET", "/api/gmaps/quota", { token: zeroLogin.json.token });
  assert.equal(qZero.status, 200);
  assert.equal(qZero.json.empCap, 0);
  assert.equal(qZero.json.empRemaining, 0);
  assert.equal(qZero.json.apiKeyConfigured, false);
  const searchZero = await apiReq(apiUrl, "POST", "/api/gmaps/search", {
    token: zeroLogin.json.token,
    body: { textQuery: "valve distributor Riyadh" },
  });
  assert.equal(searchZero.status, 403);
  assert.equal(searchZero.json.code, "EMP_QUOTA_DISABLED");
  console.log("PASS B4 (D07/S14): cap=0 hard-blocked with 403 EMP_QUOTA_DISABLED and /api/gmaps/quota verified");

  // 6. D08 / S08: change-password D1 rate limiting
  let hit429 = false;
  for (let i = 0; i < 8; i++) {
    const r = await apiReq(apiUrl, "POST", "/api/auth/change-password", {
      token: zeroLogin.json.token,
      body: { old_password: "WrongPassword999", new_password: "NewPassword123" },
    });
    if (r.status === 429 && r.json.code === "RATE_LIMITED") {
      hit429 = true;
      break;
    }
  }
  assert.equal(hit429, true, "change-password must trigger D1 persistent 429 RATE_LIMITED after repeated failures");
  console.log("PASS B5 (D08/S08): /api/auth/change-password persistent D1 rate limit triggers 429 RATE_LIMITED");

  // 7. D06: Authoritative server-side quote & compliance-log enforcement
  const memALogin = await apiReq(apiUrl, "POST", "/api/auth/login", {
    body: { login_id: "member_a", password: "MemberPass123" },
  });
  const memAToken = memALogin.json.token;
  const cUnverified = await apiReq(apiUrl, "POST", "/api/companies", {
    token: memAToken,
    body: { canonical_name: "Riyadh Valve Works", country_en: "Saudi Arabia", city: "Riyadh", website: "https://riyadhvalves.sa" },
  });
  assert.equal(cUnverified.status, 201);
  const cid1 = cUnverified.json.company.id;

  // Formal quote on unverified company -> 403
  const qFormalBlocked = await apiReq(apiUrl, "POST", `/api/companies/${cid1}/quotes`, {
    token: memAToken,
    body: { ref_no: "RFQ-TEST-01", quote_tier: "formal", payload: { qty: 100, fx: 7.2, fobTotal: 15000 } },
  });
  assert.equal(qFormalBlocked.status, 403);
  // Negative qty -> 400
  const qBadQty = await apiReq(apiUrl, "POST", `/api/companies/${cid1}/quotes`, {
    token: memAToken,
    body: { ref_no: "RFQ-TEST-02", quote_tier: "indicative", payload: { qty: -5, fx: 7.2, fobTotal: 15000 } },
  });
  assert.equal(qBadQty.status, 400);
  // Empty checks approved compliance log -> 400
  const clEmpty = await apiReq(apiUrl, "POST", `/api/companies/${cid1}/compliance-logs`, {
    token: memAToken,
    body: { order_ref: "ORD-01", decision: "approved", checks: {} },
  });
  assert.equal(clEmpty.status, 400);
  console.log("PASS B6 (D06): Server-side quote tier/number validation and compliance-log validation enforced");

  // 8. D05 / S02: Backup -> Opt-out -> Restore (auto-freezes business APIs with 503 AND preserves opt-out) -> Post-restore verify unfreezes
  const bak1 = await apiReq(apiUrl, "POST", "/api/admin/export-backup", {
    token: bossToken,
    body: { totp_code: adminCode },
  });
  assert.equal(bak1.status, 200);
  // Now customer opts out AFTER backup snapshot
  const evOpt = await apiReq(apiUrl, "POST", "/api/events", {
    token: memAToken,
    body: { company_id: cid1, channel: "email", action_outcome: "unsubscribed", summary: "Customer opted out" },
  });
  assert.equal(evOpt.status, 201);
  // Restore older backup (where Riyadh Valve Works had opt_out_status='none')
  const restRes = await apiReq(apiUrl, "POST", "/api/admin/restore-backup", {
    token: bossToken,
    body: { totp_code: adminCode, confirmPhrase: "RESTORE_CONFIRM", tables: bak1.json.tables },
  });
  assert.equal(restRes.status, 200);
  assert.equal(restRes.json.restoreFrozen, true);
  assert.ok(restRes.json.preservedProtections.some((p) => p.id === cid1 && p.opt_out_status !== "none"), "Monotonic opt-out protection MUST NOT be downgraded by older backup");
  // Business API MUST return 503 SYSTEM_RESTORE_FROZEN while frozen!
  const frozenCall = await apiReq(apiUrl, "GET", "/api/companies", { token: memAToken });
  assert.equal(frozenCall.status, 503);
  assert.equal(frozenCall.json.code, "SYSTEM_RESTORE_FROZEN");
  // Post-restore verify clears freeze and revokes other sessions
  const verifyRes = await apiReq(apiUrl, "POST", "/api/admin/post-restore-verify", {
    token: bossToken,
    body: { totp_code: adminCode, revokeOtherSessions: true },
  });
  assert.equal(verifyRes.status, 200);
  assert.equal(verifyRes.json.report.restoreFreezeCleared, true);
  assert.ok(verifyRes.json.report.optOutProtectedCount >= 1);
  // Member A's old session was revoked during post-restore verify -> 401
  const oldTokCall = await apiReq(apiUrl, "GET", "/api/companies", { token: memAToken });
  assert.equal(oldTokCall.status, 401);
  console.log("PASS B7 (D05/S02): Backup restore auto-freezes with 503, monotonically preserves opt-out, and post-restore-verify unfreezes & revokes stale sessions");

  // ===== REAL HEADLESS CHROME E2E CHECKS (D01, D02, D09/S01, S03, S04, S05, S06, S07, S09, D11/S11, D12, Plan A) =====
  const cdp = await launchChrome();
  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${staticPort}/index.html` });
    await new Promise((r) => setTimeout(r, 1200));
    await cdp.evalJs(`window.FG_CLOUD.setApiBase(${JSON.stringify(apiUrl)});`);

    // PASS F1: Naming Plan A + D11 60-day alert window + S11 Oman/Ghana/Bangladesh + S10 footer build badge
    const staticChecks = await cdp.evalJs(`(() => {
      const bodyText = document.body.innerText;
      const msOpts = Array.from(document.querySelectorAll("#msCountry option")).map(o => o.value);
      const alertsDef = window.FG_CORE.getUpcomingGlobalTradeAlerts("2026-01-01");
      const allAlerts = [].concat(alertsDef.activeOrSoon || [], alertsDef.preStocking || []);
      const maxDays = allAlerts.reduce((m, a) => Math.max(m, a.daysAway || 0), 0);
      const authBtnText = document.getElementById("btnCloudAuth").textContent;
      const footerVer = (document.getElementById("fgBuildBadge") || {}).textContent || "";
      return {
        hasOldStaffWord: bodyText.includes("员工登录") || bodyText.includes("Durable Object"),
        authBtnText,
        hasOman: msOpts.includes("Oman"),
        hasGhana: msOpts.includes("Ghana"),
        hasBangladesh: msOpts.includes("Bangladesh"),
        maxDays,
        footerVer,
        buildMeta: window.FG_BUILD_META
      };
    })()`);
    assert.equal(staticChecks.hasOldStaffWord, false, "Zero legacy '员工登录' or 'Durable Object' wording allowed");
    assert.ok(staticChecks.authBtnText.includes("成员登录"));
    assert.equal(staticChecks.hasOman && staticChecks.hasGhana && staticChecks.hasBangladesh, true, "Oman, Ghana, Bangladesh must exist in #msCountry");
    assert.ok(staticChecks.maxDays <= 60, `Expected <=60d trade alert horizon, got ${staticChecks.maxDays}`);
    assert.equal(staticChecks.buildMeta.schemaVersion, 2);
    console.log("PASS F1 (Plan A / D11 / D12 / S10 / S11): Naming Plan A, 60d horizon, Oman/Ghana/Bangladesh & build metadata verified");

    // PASS F2: S03 Gentle non-blocking must_reset_pwd reminder + D01/D02 offline & failed queue resilience
    const d01d02 = await cdp.evalJs(`(async () => {
      await window.FG_CLOUD.login("member_a", "MemberPass123");
      await new Promise(r => setTimeout(r, 400));
      // S03: must_reset_pwd is true, modal MUST NOT trap/block business UI, subtle reminder button in status line
      const modalHiddenAfterLogin = document.getElementById("cloudAuthModal").hidden;
      const statusHtml = (document.getElementById("cloudSyncStatusLine") || {}).textContent || "";
      const hasGentlePwdHint = statusHtml.includes("修改初始密码") || statusHtml.includes("初始密码");

      // Create a fresh active company for queue tests
      const c2 = await window.FG_CLOUD.createCompany({
        canonical_name: "Monterrey Steel Valve SA",
        country_en: "Mexico",
        city: "Monterrey",
        website: "https://mtyvalve.mx",
        product_summary: "工业阀门"
      });
      const cid2 = c2.data.company.id;

      // D01-A: Transient HTTP 503 during flush MUST keep item in pending queue and set status="error" (NEVER drop or mark synced!)
      const realFetch = window.fetch;
      window.fetch = () => Promise.reject(new TypeError("Offline"));
      const evQueued = await window.FG_CLOUD.recordEvent({ company_id: cid2, channel: "email", action_outcome: "sent", summary: "D01 transient test" });
      assertTrue = (v, m) => { if (!v) throw new Error(m); };
      assertTrue(evQueued.queuedOffline === true, "Offline event must enqueue");

      window.fetch = async () => new Response(JSON.stringify({ error: "Temporary 503" }), { status: 503, headers: { "Content-Type": "application/json" } });
      const fl503 = await window.FG_CLOUD.flushPendingQueue();
      const pendingAfter503 = window.FG_CLOUD.getPendingQueue().length;
      const statusAfter503 = window.FG_CLOUD.getState().syncStatus;

      // D01-B: Permanent HTTP 400 during flush MUST move item to visible failed queue (NEVER silently drop!)
      window.fetch = async () => new Response(JSON.stringify({ error: "Invalid payload test" }), { status: 400, headers: { "Content-Type": "application/json" } });
      const fl400 = await window.FG_CLOUD.flushPendingQueue();
      const pendingAfter400 = window.FG_CLOUD.getPendingQueue().length;
      const failedAfter400 = window.FG_CLOUD.getFailedQueue().length;

      // Restore real fetch & retry failed item -> succeeds cleanly!
      window.fetch = realFetch;
      const retryRes = await window.FG_CLOUD.retryFailedQueue();
      const failedAfterRetry = window.FG_CLOUD.getFailedQueue().length;

      // D02: Queue overflow guard (>200 items MUST return queueFull: true without truncating existing items)
      const seed200 = Array.from({ length: 200 }, (_, i) => ({ event_id: "ev_cap_" + i, company_id: cid2, channel: "email", action_outcome: "sent", summary: "s" }));
      localStorage.setItem("friesgo_cloud_pending_v1", JSON.stringify(seed200));
      window.fetch = () => Promise.reject(new TypeError("Offline"));
      const overflowRes = await window.FG_CLOUD.recordEvent({ company_id: cid2, channel: "email", action_outcome: "sent", summary: "201st item" });
      const countAtCap = window.FG_CLOUD.getPendingQueue().length;
      localStorage.setItem("friesgo_cloud_pending_v1", "[]");
      window.fetch = realFetch;
      await window.FG_CLOUD.flushPendingQueue();

      return {
        cid2,
        modalHiddenAfterLogin,
        hasGentlePwdHint,
        pendingAfter503,
        statusAfter503,
        fl503Failed: fl503.failed,
        pendingAfter400,
        failedAfter400,
        failedAfterRetry,
        retryFlushed: retryRes.flushed,
        overflowQueueFull: overflowRes.queueFull === true,
        countAtCap
      };
    })()`);
    assert.equal(d01d02.modalHiddenAfterLogin, true, "S03: must_reset_pwd must be non-blocking");
    assert.equal(d01d02.hasGentlePwdHint, true, "S03: gentle password change reminder must be visible");
    assert.equal(d01d02.pendingAfter503, 1, "D01: HTTP 503 MUST keep event in pending queue");
    assert.equal(d01d02.statusAfter503, "error", "D01: HTTP 503 MUST NOT mark syncStatus as synced");
    assert.equal(d01d02.pendingAfter400, 0);
    assert.equal(d01d02.failedAfter400, 1, "D01: Permanent 4xx MUST move event to visible failed queue");
    assert.equal(d01d02.retryFlushed, 1);
    assert.equal(d01d02.failedAfterRetry, 0);
    assert.equal(d01d02.overflowQueueFull, true, "D02: 201st offline event MUST return queueFull: true");
    assert.equal(d01d02.countAtCap, 200, "D02: Existing 200 queued events MUST NOT be silently sliced");
    console.log("PASS F2 (D01/D02/S03): Offline 503 retention, 4xx visible failed queue + retry, 200-item cap & gentle S03 reminder verified");

    // PASS F3: D09 / S01 / S05 / S07 Full Cloud Cross-Module Loop + Beijing Time (UTC+8)
    const loopRes = await cdp.evalJs(`(async () => {
      const cid2 = ${JSON.stringify(d01d02.cid2)};
      // Check Home Workspace Cloud Banner
      navigateTo("home-workspace");
      await new Promise(r => setTimeout(r, 350));
      const homeBannerVisible = !document.getElementById("homeCloudPoolBanner").hidden;
      const homeBannerTxt = document.getElementById("homeCloudPoolBanner").textContent;

      // Open Cloud Company Detail -> Edit Company + Add Contact (S05)
      navigateTo("client-list");
      await new Promise(r => setTimeout(r, 350));
      await window.FG_CLOUD_UI.openCloudCompanyDetail(cid2);
      await new Promise(r => setTimeout(r, 450));

      const detailBefore = document.getElementById("cloudPoolDetailBox").textContent;
      const hasBjt = detailBefore.includes("UTC+8") || detailBefore.includes("北京时间");
      const hasRawUtc = /\\bUTC\\b(?!\\+8)/.test(detailBefore);

      // Edit company info
      document.getElementById("btnDetailToggleEdit").click();
      document.getElementById("edCompNote").value = "已核实高压闸阀采购需求";
      document.getElementById("btnDetailSaveEdit").click();
      await new Promise(r => setTimeout(r, 450));

      // Add a contact
      document.getElementById("btnDetailToggleContact").click();
      document.getElementById("edCtName").value = "Carlos Mendez";
      document.getElementById("edCtRole").value = "Procurement Manager";
      document.getElementById("edCtEmail").value = "carlos@mtyvalve.mx";
      document.getElementById("edCtPhone").value = "+52 81 8345 6789";
      document.getElementById("btnDetailSaveContact").click();
      await new Promise(r => setTimeout(r, 450));

      // Jump 1: Due Diligence -> Approve & Sync directly to Cloud D1!
      document.getElementById("btnDetailJumpDd").click();
      await new Promise(r => setTimeout(r, 350));
      document.querySelectorAll("#ddVerdictChecks input[type='checkbox']").forEach(cb => { cb.checked = true; cb.dispatchEvent(new Event("change")); });
      document.getElementById("ddReviewer").value = "余佳林";
      document.getElementById("ddEvidence").value = "OFAC/CSL 无命中 + GLEIF 实体已验";
      document.getElementById("ddDecision").value = "approved";
      document.getElementById("ddDecision").dispatchEvent(new Event("change"));
      document.getElementById("btnDdSaveCrm").click();
      await new Promise(r => setTimeout(r, 500));

      // Jump 2: Quote Calculator -> verify cloud:<cid2> option exists & save Formal Quote to Cloud D1!
      navigateTo("client-list");
      await window.FG_CLOUD_UI.openCloudCompanyDetail(cid2);
      await new Promise(r => setTimeout(r, 400));
      document.getElementById("btnDetailJumpQuote").click();
      await new Promise(r => setTimeout(r, 450));
      const qcSel = document.getElementById("qcBindClient");
      const qcVal = qcSel.value;
      const hasCloudOption = Array.from(qcSel.options).some(o => o.value === "cloud:" + cid2);
      // Fill valid quote inputs & save
      document.getElementById("qcFactoryRmb").value = "100";
      document.getElementById("qcQty").value = "200";
      document.getElementById("qcFactoryRmb").dispatchEvent(new Event("input"));
      await new Promise(r => setTimeout(r, 200));
      document.getElementById("btnSaveQuoteVersion").click();
      await new Promise(r => setTimeout(r, 500));

      // Jump 3: Precheck -> verify cloud:<cid2> bound & save 6-step Compliance Log to Cloud D1!
      navigateTo("client-list");
      await window.FG_CLOUD_UI.openCloudCompanyDetail(cid2);
      await new Promise(r => setTimeout(r, 400));
      document.getElementById("btnDetailJumpPrecheck").click();
      await new Promise(r => setTimeout(r, 400));
      const pcSel = document.getElementById("pcBindClient");
      const pcVal = pcSel.value;
      document.getElementById("pcOrderRef").value = "ORD-MTY-2026-01";
      document.getElementById("pcProductHs").value = "工业铸钢闸阀 HS 8481.80";
      document.getElementById("pcEndUser").value = "Monterrey Industrial Pipeline";
      document.getElementById("pcEvidence").value = "PO#8821 + GLEIF Verified";
      document.getElementById("pcReviewer").value = "余佳林";
      document.querySelectorAll("#complianceChecklist input[type='checkbox']").forEach(cb => { cb.checked = true; cb.dispatchEvent(new Event("change")); });
      const pcDec = document.getElementById("pcDecision");
      if (pcDec) { pcDec.value = "approved"; pcDec.dispatchEvent(new Event("change")); }
      document.getElementById("btnSavePrecheckOrder").click();
      await new Promise(r => setTimeout(r, 500));

      // Verify Cloud Detail now displays contact, note, quote & compliance log from D1!
      const detAfter = await window.FG_CLOUD.getCompany(cid2);
      return {
        homeBannerVisible,
        homeBannerHasCount: /\\d+/.test(homeBannerTxt),
        hasBjt,
        hasRawUtc,
        qcVal,
        hasCloudOption,
        pcVal,
        noteSaved: detAfter.data.company.note,
        complianceStatus: detAfter.data.company.compliance_status,
        contactsCount: (detAfter.data.contacts || []).length,
        quotesCount: (detAfter.data.quotes || []).length,
        compLogsCount: (detAfter.data.complianceLogs || []).length
      };
    })()`);
    assert.equal(loopRes.homeBannerVisible && loopRes.homeBannerHasCount, true, "Home workspace cloud banner must show live cloud pool count");
    assert.equal(loopRes.hasBjt, true, "S07: Cloud detail timestamps must be formatted in Beijing Time (UTC+8)");
    assert.equal(loopRes.hasRawUtc, false, "S07: Zero raw UTC timestamps allowed in Cloud UI");
    assert.equal(loopRes.hasCloudOption, true, "D09/S01: Quote calculator must list cloud companies");
    assert.equal(loopRes.qcVal, "cloud:" + d01d02.cid2);
    assert.equal(loopRes.pcVal, "cloud:" + d01d02.cid2);
    assert.ok(loopRes.noteSaved.includes("已核实高压闸阀采购需求"), "Prior sales note must be preserved after DD sync");
    assert.ok(loopRes.noteSaved.includes("[背调 "), "DD summary must be appended to cloud note");
    assert.equal(loopRes.complianceStatus, "approved", "D09/S01: DD save must update cloud compliance_status to approved");
    assert.ok(loopRes.contactsCount >= 1, "S05: Added contact must persist to D1");
    assert.ok(loopRes.quotesCount >= 1, "D09/S01: Saved quote must persist to cloud D1 quote_records");
    assert.ok(loopRes.compLogsCount >= 1, "D09/S01: Saved precheck must persist to cloud D1 compliance_order_logs");
    console.log("PASS F3 (D09/S01/S05/S07): Full Cloud Cross-Module Loop (Detail Edit/Contact -> DD -> Quote -> Precheck -> Home Banner + UTC+8) verified");

    // PASS F4: S04 Boss Admin UI controls (Reset Password, Role/Quota, Inspect Devices, Restore Upload)
    const adminUiRes = await cdp.evalJs(`(async () => {
      await window.FG_CLOUD.logout();
      const loginCode2 = ${JSON.stringify(await generateTotpCode(totpSecret, Date.now() + 30000))};
      await window.FG_CLOUD.login("boss", "BossPassword123", loginCode2);
      await window.FG_CLOUD_UI.openAdminModal();
      await new Promise(r => setTimeout(r, 450));
      const hasResetPwdBtn = document.querySelectorAll("[data-adm-resetpwd]").length > 0;
      const hasEditRoleCapBtn = document.querySelectorAll("[data-adm-editcap]").length > 0;
      const hasSingleDeviceBtn = document.querySelectorAll("[data-adm-sessions]").length > 0;
      // Switch to Backup tab
      const bakTab = document.querySelector("[data-admtab='backup']");
      if (bakTab) bakTab.click();
      await new Promise(r => setTimeout(r, 250));
      const hasRestoreBtn = !!document.getElementById("btnAdminDoRestore");
      const hasPostVerifyBtn = !!document.getElementById("btnAdminPostRestore");
      document.getElementById("cloudAdminModal").hidden = true;
      return { hasResetPwdBtn, hasEditRoleCapBtn, hasSingleDeviceBtn, hasRestoreBtn, hasPostVerifyBtn };
    })()`);
    assert.equal(adminUiRes.hasResetPwdBtn, true, "S04: Admin UI must render Reset Password button");
    assert.equal(adminUiRes.hasEditRoleCapBtn, true, "S04: Admin UI must render Role/Quota button");
    assert.equal(adminUiRes.hasSingleDeviceBtn, true, "S04: Admin UI must render Inspect Device button");
    assert.equal(adminUiRes.hasRestoreBtn, true, "S04: Admin Backup tab must render Restore JSON button");
    assert.equal(adminUiRes.hasPostVerifyBtn, true, "S04: Admin Backup tab must render Post-Restore Verify button");
    console.log("PASS F4 (S04): Super-Admin governance controls (reset pwd, role/quota, single-device inspect, restore upload) verified");

    // PASS F5: S06 + S09 Exact 360px Mobile Viewport Zero Horizontal Overflow & Compact Topbar Pill
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 2, mobile: true });
    await new Promise((r) => setTimeout(r, 350));
    const mob360 = await cdp.evalJs(`(async () => {
      window.dispatchEvent(new Event("resize"));
      await new Promise(r => setTimeout(r, 200));
      const results = {};
      for (const tool of ["lead-finder", "client-list", "map-scraper", "home-workspace", "quote-calc"]) {
        navigateTo(tool);
        if (tool === "client-list") window.FG_CLOUD_UI.loadCloudActiveTab();
        await new Promise(r => setTimeout(r, 250));
        results[tool] = Math.max(0, document.documentElement.scrollWidth - window.innerWidth);
      }
      const pillTxt = document.getElementById("btnCloudAuth").textContent.trim();
      const pillW = Math.round(document.getElementById("btnCloudAuth").getBoundingClientRect().width);
      return { results, pillTxt, pillW };
    })()`);
    for (const [tool, ov] of Object.entries(mob360.results)) {
      assert.equal(ov, 0, `S06: Expected 0px horizontal overflow on exact 360px for #${tool}, got ${ov}px`);
    }
    assert.ok(mob360.pillW <= 165, `S09: 360px auth pill should stay compact (<=165px), got ${mob360.pillW}px ("${mob360.pillTxt}")`);
    assert.equal(cdp.pageErrors.length, 0, `Uncaught page errors: ${cdp.pageErrors.join(" | ")}`);
    console.log(`PASS F5 (S06/S09): Exact 360px viewport verified 0px overflow across all target tools & compact auth pill (${mob360.pillW}px)`);
    console.log("ALL D01-D12 / S01-S14 / PLAN-A DIRECTED CHECKS PASSED!");
  } finally {
    try { cdp.ws.close(); } catch (_) {}
    cdp.chrome.kill("SIGKILL");
    staticSrv.close();
    apiSrv.close();
    await new Promise((r) => setTimeout(r, 250));
    try { fs.rmSync(cdp.userDataDir, { recursive: true, force: true }); } catch (_) {}
  }
})().catch((err) => {
  console.error("V2.1 D01-D12 DIRECTED VERIFICATION FAILED:", err);
  process.exit(1);
});
