// FriesGo Global V3.0 Slice 1 - Comprehensive Local Verification Suite (Real Node 24 SQLite + Real Headless Chrome)
// Strictly uses isolated in-memory SQLite, synthetic TEST identities/data, zero paid APIs, zero external messaging.
// Verifies:
//   - ENG02: Exact BigInt money, cross-decimal JPY<->USD FX, Hamilton Largest-Remainder ($0.03 / 4), refunds, D1 bounds
//   - REV01: Multi-tenant org isolation (same domain/google_place_id across orgs, cross-org parent 404, super_admin denied trial org until grant created & immediately denied after revoke, missing X-FG-Org-Id 403, browser contextEpoch stale-response discard)
//   - ENG04 / REV06 / UX01: Public application idempotency-before-Turnstile, one-time lookup_secret, non-enumerable status, disabled ref neutral fallback, minimal 3-field buyer RFQ
//   - ENG01 / ENG03: Atomic D1 DB.batch op_id concurrent accept (1 wins / 1 gets 409 / 0 duplicate events), in_progress lease recovery, revoked session idempotency denied 401, auth-proxied attachment immediate 401 after revoke
//   - ACQ01-12 / UX02-05 / REV07-09: FB/IG/LI + YouTube-excluded source comparison with exact denominators, draft/copy != manual_sent, opt-out blocking, duplicate dispatch prevention, blind-dedupe deal reg (intake_receipt vs protection_record), V4 backup & restore
//   - Real Headless Chrome: join.html, rfq.html, index.html V3 Hub + contextEpoch race + scoped drafts + 0 pageErrors

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { DatabaseSync } = require("node:sqlite");
const { findChrome } = require("./_chrome.cjs");

const ROOT = path.resolve(__dirname, "..");
const CHROME_BIN = findChrome();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SQL_0001 = fs.readFileSync(path.join(ROOT, "workers/friesgo-api/migrations/0001_init.sql"), "utf8");
const SQL_0004 = fs.readFileSync(path.join(ROOT, "workers/friesgo-api/migrations/0004_v3_slice1_orgs_acq_dispatch.sql"), "utf8");

function createV4SqliteD1() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(SQL_0001);
  raw.exec(SQL_0004);

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
        return { success: true, meta: { changes: Number(info.changes || 0), last_row_id: Number(info.lastInsertRowid || 0) } };
      },
    };
  }

  return {
    raw,
    prepare(sql) {
      return wrapStmt(sql, []);
    },
    async batch(stmts) {
      raw.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const st of stmts) results.push(await st.run());
        raw.exec("COMMIT");
        return results;
      } catch (e) {
        try { raw.exec("ROLLBACK"); } catch {}
        throw e;
      }
    },
  };
}

function makeEnv(db, overrides = {}) {
  return {
    DB: db,
    ENVIRONMENT: "staging-local-test",
    V3_SLICE1_ENABLED: "1",
    BUILD_COMMIT: "v3slice1localtestcommit00000000000000000",
    ALLOWED_ORIGINS: "http://127.0.0.1,http://localhost,https://jasunmr389-ship-it.github.io",
    AUTH_PEPPER: "v3_slice1_test_pepper_32_chars_min_1234",
    TOTP_ENC_KEY: Buffer.alloc(32, 7).toString("base64"),
    BOOTSTRAP_SECRET: "v3_slice1_boot_secret_32_chars_min_1234",
    LOCK_TTL_SECONDS: "600",
    SESSION_TTL_DAYS: "30",
    ...overrides,
  };
}

async function callApi(worker, env, method, urlPath, { token = "", orgId = "", memId = "", idemKey = "", headers = {}, body = undefined } = {}) {
  const hdrs = {
    Origin: "http://127.0.0.1",
    ...headers,
  };
  if (token) hdrs.Authorization = `Bearer ${token}`;
  if (orgId) hdrs["X-FG-Org-Id"] = orgId;
  if (memId) hdrs["X-FG-Membership-Id"] = memId;
  if (idemKey) hdrs["X-Idempotency-Key"] = idemKey;
  if (body !== undefined) hdrs["Content-Type"] = "application/json";
  const req = new Request(`https://api.test.local${urlPath}`, {
    method,
    headers: hdrs,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const resp = await worker.fetch(req, env);
  const ct = resp.headers.get("Content-Type") || "";
  const data = ct.includes("application/json") ? await resp.json() : await resp.text();
  return { status: resp.status, headers: resp.headers, data };
}

async function launchChromePage(url) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-v3s1-chrome-"));
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
    setTimeout(() => reject(new Error("Chrome startup timeout")), 15000);
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
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url });
  await sleep(700);
  return {
    send,
    evalJs,
    pageErrors,
    navigate: async (nextUrl) => {
      await send("Page.navigate", { url: nextUrl });
      await sleep(700);
    },
    close: async () => {
      try { ws.close(); } catch {}
      try { chrome.kill("SIGTERM"); } catch {}
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    },
  };
}

async function main() {
  const moneyMod = await import(pathToFileURL(path.join(ROOT, "workers/friesgo-api/src/money.js")).href);
  const workerMod = await import(pathToFileURL(path.join(ROOT, "workers/friesgo-api/src/index.js")).href);
  const totpMod = await import(pathToFileURL(path.join(ROOT, "workers/friesgo-api/src/totp.js")).href);
  const worker = workerMod.default;

  // =========================================================================
  // BLOCK 1: ENG02 Exact BigInt Monetary, Cross-Decimal FX & Largest-Remainder Proofs
  // =========================================================================
  {
    // 1.1 JPY 1,000 -> USD at 0.0067 = USD 6.70 (670 minor), NOT $0.07!
    const jpyToUsd = moneyMod.convertCurrencyMinor({
      sourceMinor: 1000,
      sourceCurrency: "JPY",
      targetCurrency: "USD",
      fxRateDec: "0.0067",
    });
    assert.equal(jpyToUsd, 670, "JPY 1,000 * 0.0067 must equal USD 6.70 (670 cents)");
    assert.equal(moneyMod.formatMinor(jpyToUsd, "USD"), "6.70");

    // 1.2 USD 6.70 -> JPY at 149.253731 = JPY 1,000
    const usdToJpy = moneyMod.convertCurrencyMinor({
      sourceMinor: 670,
      sourceCurrency: "USD",
      targetCurrency: "JPY",
      fxRateDec: "149.253731",
    });
    assert.equal(usdToJpy, 1000, "USD 6.70 -> JPY must equal 1000 JPY");

    // 1.3 JPY Refund (-1,000 JPY -> -6.70 USD)
    const jpyRefundUsd = moneyMod.convertCurrencyMinor({
      sourceMinor: -1000,
      sourceCurrency: "JPY",
      targetCurrency: "USD",
      fxRateDec: "0.0067",
    });
    assert.equal(jpyRefundUsd, -670);

    // 1.4 ENG02 Counterexample: USD $0.03 split across 4 equal partners (250,000 ppm each)
    const sharesFwd = [
      { id: "p_a", rolePriority: 1, weightPpm: 250000 },
      { id: "p_b", rolePriority: 1, weightPpm: 250000 },
      { id: "p_c", rolePriority: 1, weightPpm: 250000 },
      { id: "p_d", rolePriority: 1, weightPpm: 250000 },
    ];
    const splitFwd = moneyMod.splitCommissionLargestRemainder({ totalCommissionMinor: 3, shares: sharesFwd });
    const splitRev = moneyMod.splitCommissionLargestRemainder({ totalCommissionMinor: 3, shares: sharesFwd.slice().reverse() });
    const mapFwd = Object.fromEntries(splitFwd.allocations.map((a) => [a.id, a.amountMinor]));
    const mapRev = Object.fromEntries(splitRev.allocations.map((a) => [a.id, a.amountMinor]));
    assert.deepEqual(mapFwd, { p_a: 1, p_b: 1, p_c: 1, p_d: 0 }, "Hamilton Largest-Remainder must distribute 3 cents as 1/1/1/0");
    assert.deepEqual(mapFwd, mapRev, "Tie-break must be completely independent of input array ordering");
    assert.equal(splitFwd.companyRetainedMinor, 0);
    assert.equal(splitFwd.unallocatedPoolMinor, 0);

    // 1.5 Negative refund symmetry (-$0.03 / 4)
    const splitNeg = moneyMod.splitCommissionLargestRemainder({ totalCommissionMinor: -3, shares: sharesFwd });
    const mapNeg = Object.fromEntries(splitNeg.allocations.map((a) => [a.id, a.amountMinor]));
    assert.deepEqual(mapNeg, { p_a: -1, p_b: -1, p_c: -1, p_d: 0 }, "Negative refund split must mirror positive split symmetrically");

    // 1.6 Company retained vs unallocated pool separation
    const splitSep = moneyMod.splitCommissionLargestRemainder({
      totalCommissionMinor: 10000,
      shares: [{ id: "p_main", rolePriority: 2, weightPpm: 300000 }],
      companyRetainedPpm: 200000,
    });
    assert.equal(splitSep.allocations[0].amountMinor, 3000);
    assert.equal(splitSep.companyRetainedMinor, 2000);
    assert.equal(splitSep.unallocatedPoolMinor, 5000);

    // 1.7 Exact fixed_per_unit decimal calculation & pct_of_commissionable
    const fixedLine = moneyMod.calculateLineCommissionMinor({
      calcMode: "fixed_per_unit",
      currency: "USD",
      qtyDec: "18.3750",
      unitRateDec: "12.3450",
    });
    // 18.375 * 12.345 = 226.839375 -> 22684 minor ($226.84)
    assert.equal(fixedLine, 22684);
    const pctLine = moneyMod.calculateLineCommissionMinor({
      calcMode: "pct_of_commissionable",
      currency: "USD",
      commissionableMinor: 333333,
      ratePpm: 35000, // 3.5% -> 11666.655 -> 11667
    });
    assert.equal(pctLine, 11667);

    // 1.8 D1 safe integer overflow & unsupported currency guards
    assert.throws(() => moneyMod.assertD1SafeInt(9007199254740992n), /D1_SAFE_INT_OVERFLOW/);
    assert.throws(() => moneyMod.parseMoneyToMinor("10.00", "ZZZ"), /UNSUPPORTED_CURRENCY/);
    console.log("PASS BLOCK 1 (ENG02): JPY<->USD cross-decimal FX, $0.03/4 Largest-Remainder, negative symmetry, retained vs unallocated, fixed_per_unit & D1 safe-int guards verified");
  }

  // =========================================================================
  // Setup Real SQLite V4 DB + Bootstrap Admin + Activate Test Roles
  // =========================================================================
  const db = createV4SqliteD1();
  const usedTurnstileTokens = new Set();
  const env = makeEnv(db, {
    TURNSTILE_SECRET_KEY: "test_turnstile_secret_v3",
    __TURNSTILE_VERIFY_FN: async (token) => {
      if (token === "ts_invalid") return { ok: false };
      if (usedTurnstileTokens.has(token)) return { ok: false }; // single-use Turnstile simulation!
      usedTurnstileTokens.add(token);
      return { ok: true };
    },
  });

  // Verify /api/health reports Schema v4 ready
  const health = await callApi(worker, env, "GET", "/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.data.schemaVersion, 4);
  assert.equal(health.data.expectedSchemaVersion, 4);
  assert.equal(health.data.schemaReady, true);

  // Bootstrap TEST super_admin & enroll TOTP
  const boot = await callApi(worker, env, "POST", "/api/auth/bootstrap", {
    headers: { "X-Bootstrap-Secret": env.BOOTSTRAP_SECRET },
    body: { login_id: "test_admin", display_name: "TEST Admin", password: "TestAdmin2026!" },
  });
  assert.equal(boot.status, 201);
  const adminLogin = await callApi(worker, env, "POST", "/api/auth/login", {
    body: { login_id: "test_admin", password: "TestAdmin2026!" },
  });
  assert.equal(adminLogin.status, 200);
  const adminToken = adminLogin.data.token;
  const adminId = adminLogin.data.employee.id;

  const totpInit = await callApi(worker, env, "POST", "/api/auth/totp/setup", { token: adminToken });
  assert.equal(totpInit.status, 200);
  const adminTotpSecret = totpInit.data.secretBase32;
  const getAdminTotp = () => totpMod.generateTotpCode(adminTotpSecret);
  const totpVerify = await callApi(worker, env, "POST", "/api/auth/totp/confirm", {
    token: adminToken,
    body: { totp_code: await getAdminTotp() },
  });
  assert.equal(totpVerify.status, 200);

  // =========================================================================
  // BLOCK 2 (ENG04 + REV06 + UX01): Public Intake, Lost-Receipt Replay, Non-Enumerable Status & Minimal RFQ
  // =========================================================================
  let partnerAppId = "";
  let trialAAppId = "";
  let trialBAppId = "";
  {
    // 2.1 ENG04: Submit application with single-use Turnstile token, then replay with SAME idem_key & expired Turnstile token
    const appPayload = {
      app_type: "partner",
      partner_mode: "followup",
      applicant_name: "TEST Partner Followup",
      country_tz: "UAE (UTC+4)",
      languages: "English, Arabic",
      contact_channel: "wechat",
      contact_value: "test_wx_partner_1",
      product_lines: ["valves", "pe_pipes"],
      privacyConsent: true,
      marketingOptIn: false,
      turnstile_token: "ts_once_partner_1",
    };
    const app1 = await callApi(worker, env, "POST", "/api/public/applications", {
      idemKey: "idem_app_lost_receipt_1",
      body: appPayload,
    });
    assert.equal(app1.status, 201);
    assert.equal(app1.data.replayed, false);
    assert.ok(app1.data.application_no.startsWith("FG-APP-"));
    assert.ok(app1.data.lookup_secret && app1.data.lookup_secret.startsWith("fglk_"));

    // Replay same idem_key with now-EXPIRED single-use Turnstile token -> MUST succeed 200 without re-exposing lookup_secret!
    const appReplay = await callApi(worker, env, "POST", "/api/public/applications", {
      idemKey: "idem_app_lost_receipt_1",
      body: appPayload,
    });
    assert.equal(appReplay.status, 200);
    assert.equal(appReplay.data.replayed, true);
    assert.equal(appReplay.data.application_no, app1.data.application_no);
    assert.equal(appReplay.data.lookup_secret, undefined, "ENG04: Replay must NEVER re-expose one-time lookup_secret!");

    // Same idem_key with altered payload -> 409 IDEMPOTENCY_PAYLOAD_MISMATCH
    const appTamper = await callApi(worker, env, "POST", "/api/public/applications", {
      idemKey: "idem_app_lost_receipt_1",
      body: { ...appPayload, applicant_name: "Tampered Name" },
    });
    assert.equal(appTamper.status, 409);
    assert.equal(appTamper.data.code, "IDEMPOTENCY_PAYLOAD_MISMATCH");

    // Status lookup works repeatedly with exact (application_no, lookup_secret), 404 on wrong secret or guessed ID
    const stOk1 = await callApi(worker, env, "POST", "/api/public/applications/status", {
      body: { application_no: app1.data.application_no, lookup_secret: app1.data.lookup_secret },
    });
    assert.equal(stOk1.status, 200);
    assert.equal(stOk1.data.status, "submitted");
    const stOk2 = await callApi(worker, env, "POST", "/api/public/applications/status", {
      body: { application_no: app1.data.application_no, lookup_secret: app1.data.lookup_secret },
    });
    assert.equal(stOk2.status, 200, "Lookup secret is shown once but reusable for status queries");

    const stWrongSecret = await callApi(worker, env, "POST", "/api/public/applications/status", {
      body: { application_no: app1.data.application_no, lookup_secret: "fglk_wrong_secret" },
    });
    const stGuessedId = await callApi(worker, env, "POST", "/api/public/applications/status", {
      body: { application_no: "FG-APP-20260101-AAAAAA", lookup_secret: "fglk_wrong_secret" },
    });
    assert.equal(stWrongSecret.status, 404);
    assert.equal(stGuessedId.status, 404);
    assert.equal(stWrongSecret.data.code, stGuessedId.data.code, "Non-enumerable identical 404 response");

    // Submit 2 independent tool_trial applications for REV01 multi-tenant testing
    const trA = await callApi(worker, env, "POST", "/api/public/applications", {
      idemKey: "idem_trial_a",
      body: {
        app_type: "tool_trial",
        applicant_name: "TEST Trial Org A",
        contact_channel: "email",
        contact_value: "trial_a@example.test",
        privacyConsent: true,
        turnstile_token: "ts_once_trial_a",
      },
    });
    assert.equal(trA.status, 201);
    const trB = await callApi(worker, env, "POST", "/api/public/applications", {
      idemKey: "idem_trial_b",
      body: {
        app_type: "tool_trial",
        applicant_name: "TEST Trial Org B",
        contact_channel: "email",
        contact_value: "trial_b@example.test",
        privacyConsent: true,
        turnstile_token: "ts_once_trial_b",
      },
    });
    assert.equal(trB.status, 201);

    // Manager fetches applications & verifies separated review -> activate flow (REV09)
    const appsList = await callApi(worker, env, "GET", "/api/v3/applications", { token: adminToken, orgId: "org_friesgo_main" });
    assert.equal(appsList.status, 200);
    partnerAppId = appsList.data.applications.find((a) => a.application_no === app1.data.application_no).id;
    trialAAppId = appsList.data.applications.find((a) => a.application_no === trA.data.application_no).id;
    trialBAppId = appsList.data.applications.find((a) => a.application_no === trB.data.application_no).id;

    // Premature activation before approval must fail 409
    const earlyAct = await callApi(worker, env, "POST", `/api/v3/applications/${partnerAppId}/activate`, {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { login_id: "test_partner_1" },
    });
    assert.equal(earlyAct.status, 409);
    assert.equal(earlyAct.data.code, "ACTIVATION_REQUIRES_APPROVAL");

    // Review -> approve -> activate all three
    for (const [aid, lid, extra] of [
      [partnerAppId, "test_partner_1", { partner_ref_code: "PTN-TEST01", partner_approved_title: "TEST Gulf Industrial Partner" }],
      [trialAAppId, "test_trial_a", {}],
      [trialBAppId, "test_trial_b", {}],
    ]) {
      const rev = await callApi(worker, env, "PATCH", `/api/v3/applications/${aid}`, {
        token: adminToken,
        orgId: "org_friesgo_main",
        body: { status: "approved", quiz_score: 100, quiz_passed: true },
      });
      assert.equal(rev.status, 200);
      const act = await callApi(worker, env, "POST", `/api/v3/applications/${aid}/activate`, {
        token: adminToken,
        orgId: "org_friesgo_main",
        body: { login_id: lid, initial_password: "TestUser2026!", ...extra },
      });
      assert.equal(act.status, 200);
    }

    // 2.2 REV06 + NEW01: Catalog with valid ref vs disabled/nonexistent ref
    await callApi(worker, env, "PUT", "/api/v3/catalog/pe_pipes", {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: {
        title_en: "HDPE PE100 Pipes & Fittings",
        title_cn: "PE / HDPE 工业给排水管道",
        supply_status: "direct_supply",
        verified_certs: ["ISO 4427 (TEST)"],
        moq_note: "1x20GP reference (TEST)",
      },
    });
    const catValid = await callApi(worker, env, "GET", "/api/public/catalog?ref=PTN-TEST01");
    assert.equal(catValid.status, 200);
    assert.equal(catValid.data.referral.refValid, true);
    assert.equal(catValid.data.referral.displayTitle, "TEST Gulf Industrial Partner");
    assert.equal(catValid.data.categories.length, 1);

    const catInvalid = await callApi(worker, env, "GET", "/api/public/catalog?ref=DISABLED_OR_UNKNOWN");
    assert.equal(catInvalid.status, 200);
    assert.equal(catInvalid.data.referral.refValid, false);
    assert.equal(Object.keys(catInvalid.data.referral).length, 1, "REV06: Neutral fallback must leak zero internal disable reason");

    // 2.3 UX01 Minimal 3-field buyer RFQ (no company name, no qty, no port, no specs) + disabled ref does NOT block buyer!
    const rfqMin = await callApi(worker, env, "POST", "/api/public/rfq", {
      idemKey: "idem_rfq_min_1",
      body: {
        demandSummary: "TEST Need PE100 pipes for municipal water line, specs TBD",
        country_en: "UAE",
        contactChannel: "email",
        contactValue: "buyer.test@example.test",
        ref: "DISABLED_OR_UNKNOWN",
        privacyConsent: true,
        turnstile_token: "ts_once_rfq_1",
      },
    });
    assert.equal(rfqMin.status, 201);
    assert.equal(rfqMin.data.refRecorded, false, "Disabled ref falls back cleanly to organic");
    assert.equal(rfqMin.data.status, "need_specs");

    // Valid partner ref recorded as pending touchpoint
    const rfqRef = await callApi(worker, env, "POST", "/api/public/rfq", {
      idemKey: "idem_rfq_ref_2",
      body: {
        demandSummary: "TEST Need API 600 gate valves DN150 for refinery maintenance",
        country_en: "Saudi Arabia",
        productLine: "valves",
        contactChannel: "whatsapp",
        contactValue: "+966500000001",
        ref: "PTN-TEST01",
        privacyConsent: true,
        turnstile_token: "ts_once_rfq_2",
      },
    });
    assert.equal(rfqRef.status, 201);
    assert.equal(rfqRef.data.refRecorded, true);

    console.log("PASS BLOCK 2 (ENG04/REV06/REV09/UX01/NEW01): Idempotency-before-Turnstile, one-time lookup_secret, non-enumerable status, separated activation, neutral ref fallback & minimal 3-field buyer RFQ verified");
  }

  // Login activated users
  async function loginAs(login_id) {
    const r = await callApi(worker, env, "POST", "/api/auth/login", {
      body: { login_id, password: "TestUser2026!" },
    });
    assert.equal(r.status, 200);
    const ctxs = await callApi(worker, env, "GET", "/api/v3/me/contexts", { token: r.data.token });
    assert.equal(ctxs.status, 200);
    return { token: r.data.token, empId: r.data.employee.id, ctx: ctxs.data.contexts[0] };
  }
  const partnerUser = await loginAs("test_partner_1");
  const trialA = await loginAs("test_trial_a");
  const trialB = await loginAs("test_trial_b");

  // =========================================================================
  // BLOCK 3 (REV01): Multi-Tenant Isolation, Same Domain/PlaceID, Cross-Org Parent 404 & Support Access Grants
  // =========================================================================
  let trialACompanyId = "";
  let trialBCompanyId = "";
  {
    // Missing X-FG-Org-Id header -> 403 ORG_CONTEXT_REQUIRED (zero silent fallback to main!)
    const noHdr = await callApi(worker, env, "GET", "/api/v3/companies", { token: trialA.token });
    assert.equal(noHdr.status, 403);
    assert.equal(noHdr.data.code, "ORG_CONTEXT_REQUIRED");

    // Org A and Org B insert IDENTICAL company name, domain, AND google_place_id -> BOTH succeed independently!
    const cA = await callApi(worker, env, "POST", "/api/v3/companies", {
      token: trialA.token,
      orgId: trialA.ctx.org_id,
      body: {
        canonical_name: "TEST Shared Target Corp",
        country_en: "Germany",
        website_domain: "shared-target.example.test",
        google_place_id: "ChIJ_TEST_IDENTICAL_PLACE_999",
      },
    });
    assert.equal(cA.status, 201);
    trialACompanyId = cA.data.company.id;

    const cB = await callApi(worker, env, "POST", "/api/v3/companies", {
      token: trialB.token,
      orgId: trialB.ctx.org_id,
      body: {
        canonical_name: "TEST Shared Target Corp",
        country_en: "Germany",
        website_domain: "shared-target.example.test",
        google_place_id: "ChIJ_TEST_IDENTICAL_PLACE_999",
      },
    });
    assert.equal(cB.status, 201, "Org B must NOT collide with Org A's google_place_id or domain!");
    trialBCompanyId = cB.data.company.id;

    // Org A cannot read Org B's space (403)
    const crossRead = await callApi(worker, env, "GET", "/api/v3/companies", {
      token: trialA.token,
      orgId: trialB.ctx.org_id,
    });
    assert.equal(crossRead.status, 403);

    // Org A creates a project and attempts to bind Org B's company_id -> 404 RESOURCE_NOT_FOUND!
    const prjA = await callApi(worker, env, "POST", "/api/v3/projects", {
      token: trialA.token,
      orgId: trialA.ctx.org_id,
      body: { title: "TEST Org A Pipeline Project", country_en: "Germany" },
    });
    assert.equal(prjA.status, 201);
    const crossBind = await callApi(worker, env, "POST", `/api/v3/projects/${prjA.data.project.id}/participants`, {
      token: trialA.token,
      orgId: trialA.ctx.org_id,
      body: { company_id: trialBCompanyId, buyer_role: "epc" },
    });
    assert.equal(crossBind.status, 404, "Cross-org parent/company ID must be rejected with 404");

    // super_admin DENIED access to independent_trial org by default!
    const adminBlocked = await callApi(worker, env, "GET", "/api/v3/companies", {
      token: adminToken,
      orgId: trialA.ctx.org_id,
    });
    assert.equal(adminBlocked.status, 403);
    assert.equal(adminBlocked.data.code, "ORG_ACCESS_DENIED");

    // Trial A user grants 24h read-only support access -> super_admin can READ (200) but CANNOT WRITE (403)!
    const grantRes = await callApi(worker, env, "POST", "/api/v3/support-grants", {
      token: trialA.token,
      orgId: trialA.ctx.org_id,
      body: { ttl_hours: 24, grantee_employee_id: adminId, reason: "TEST diagnostics" },
    });
    assert.equal(grantRes.status, 201);
    const grantId = grantRes.data.grant.id;

    const adminReadOk = await callApi(worker, env, "GET", "/api/v3/companies", {
      token: adminToken,
      orgId: trialA.ctx.org_id,
    });
    assert.equal(adminReadOk.status, 200);
    assert.equal(adminReadOk.data.companies.length, 1);

    const adminWriteBlocked = await callApi(worker, env, "POST", "/api/v3/companies", {
      token: adminToken,
      orgId: trialA.ctx.org_id,
      body: { canonical_name: "Illegal Write", country_en: "US" },
    });
    assert.equal(adminWriteBlocked.status, 403);
    assert.equal(adminWriteBlocked.data.code, "SUPPORT_GRANT_READ_ONLY");

    // Trial A user revokes grant -> super_admin IMMEDIATELY denied 403 again!
    const revokeRes = await callApi(worker, env, "DELETE", `/api/v3/support-grants/${grantId}`, {
      token: trialA.token,
      orgId: trialA.ctx.org_id,
    });
    assert.equal(revokeRes.status, 200);
    const adminBlockedAgain = await callApi(worker, env, "GET", "/api/v3/companies", {
      token: adminToken,
      orgId: trialA.ctx.org_id,
    });
    assert.equal(adminBlockedAgain.status, 403);

    console.log("PASS BLOCK 3 (REV01): Multi-tenant isolation, same domain/place_id across orgs, cross-org parent 404, and super_admin support_access_grants create/readonly/revoke verified");
  }

  // =========================================================================
  // BLOCK 4 (ENG01 + ENG03): Atomic Concurrent Accept, Lease Recovery, Post-Revoke Idempotency 401 & Auth-Proxied Attachments
  // =========================================================================
  {
    // Find an existing pending_dispatch assignment from the RFQ created in Block 2
    const todosMgr = await callApi(worker, env, "GET", "/api/v3/dispatch/my-todos?scope=all", {
      token: adminToken,
      orgId: "org_friesgo_main",
    });
    assert.equal(todosMgr.status, 200);
    assert.ok(todosMgr.data.todos.length >= 1);
    const asgId = todosMgr.data.todos[0].id;

    // Assign to partnerUser
    const assignRes = await callApi(worker, env, "POST", "/api/v3/dispatch/assign", {
      token: adminToken,
      orgId: "org_friesgo_main",
      idemKey: "idem_assign_1",
      body: { assignment_id: asgId, assignee_employee_id: partnerUser.empId, accept_hours: 24, sla_timezone: "Asia/Dubai" },
    });
    assert.equal(assignRes.status, 200);
    const vNow = assignRes.data.version;

    // Concurrent competing accepts with same version & different idemKeys -> EXACTLY 1 wins (200), 1 fails (409), 1 event inserted!
    const [acc1, acc2] = await Promise.all([
      callApi(worker, env, "POST", `/api/v3/dispatch/${asgId}/accept`, {
        token: partnerUser.token,
        orgId: "org_friesgo_main",
        idemKey: "idem_accept_race_A",
        body: { version: vNow },
      }),
      callApi(worker, env, "POST", `/api/v3/dispatch/${asgId}/accept`, {
        token: partnerUser.token,
        orgId: "org_friesgo_main",
        idemKey: "idem_accept_race_B",
        body: { version: vNow },
      }),
    ]);
    const statuses = [acc1.status, acc2.status].sort();
    assert.deepEqual(statuses, [200, 409], "ENG01: Exactly one concurrent accept wins and the other receives 409");
    const evRows = db.raw.prepare("SELECT COUNT(*) AS cnt FROM assignment_events WHERE assignment_id = ? AND event_type = 'accepted'").get(asgId);
    assert.equal(Number(evRows.cnt), 1, "ENG01: Zero duplicate accepted events permitted");

    // ENG01: Simulate expired in_progress lease recovery
    const pastIso = new Date(Date.now() - 60000).toISOString();
    const { sha256Hex } = await import(pathToFileURL(path.join(ROOT, "workers/friesgo-api/src/crypto.js")).href);
    const stuckBody = { reg_tier: "relationship_reg", company_name: "TEST Lease Recovery Corp", country_en: "UAE" };
    const reqHash = await sha256Hex(JSON.stringify(stuckBody));
    db.raw
      .prepare(
        `INSERT INTO idempotency_keys (org_id, actor_id, scope, target_id, idem_key, request_sha256, state, response_status, response_json, lease_expires_at, created_at, updated_at)
         VALUES ('org_friesgo_main', ?, 'v3_deal_reg_create', '', 'idem_stuck_lease_1', ?, 'in_progress', 0, '{}', ?, ?, ?)`
      )
      .run(partnerUser.empId, reqHash, pastIso, pastIso, pastIso);

    const recovered = await callApi(worker, env, "POST", "/api/v3/partner/deal-reg", {
      token: partnerUser.token,
      orgId: "org_friesgo_main",
      idemKey: "idem_stuck_lease_1",
      body: stuckBody,
    });
    assert.equal(recovered.status, 201, "ENG01: Expired in_progress idempotency lease must recover cleanly");

    // ENG03: Upload sensitive attachment -> owner downloads 200, other org gets 404
    const upRes = await callApi(worker, env, "POST", "/api/v3/attachments", {
      token: trialB.token,
      orgId: trialB.ctx.org_id,
      body: { entity_type: "project", entity_id: "prj_test_1", filename: "secret_spec.txt", content_text: "TEST CONFIDENTIAL SPEC CONTENT" },
    });
    assert.equal(upRes.status, 201);
    const attId = upRes.data.attachment.id;

    const dlOk = await callApi(worker, env, "GET", `/api/v3/attachments/${attId}`, {
      token: trialB.token,
      orgId: trialB.ctx.org_id,
    });
    assert.equal(dlOk.status, 200);
    assert.equal(dlOk.data, "TEST CONFIDENTIAL SPEC CONTENT");
    assert.equal(dlOk.headers.get("X-FG-Access-Model"), "worker-auth-proxied");

    const dlCross = await callApi(worker, env, "GET", `/api/v3/attachments/${attId}`, {
      token: trialA.token,
      orgId: trialA.ctx.org_id,
    });
    assert.equal(dlCross.status, 404);

    // Revoke trialB's session -> BOTH attachment download (ENG03) AND completed idempotency replay (ENG01) return 401 IMMEDIATELY!
    const trialBIdem = await callApi(worker, env, "POST", "/api/v3/acq/signals", {
      token: trialB.token,
      orgId: trialB.ctx.org_id,
      idemKey: "idem_before_revoke",
      body: { source_platform: "facebook", acquisition_mode: "manual_discovery", demand_summary: "TEST signal before session revoke" },
    });
    assert.equal(trialBIdem.status, 201);

    await callApi(worker, env, "POST", "/api/auth/logout", { token: trialB.token });

    const dlAfterRevoke = await callApi(worker, env, "GET", `/api/v3/attachments/${attId}`, {
      token: trialB.token,
      orgId: trialB.ctx.org_id,
    });
    assert.equal(dlAfterRevoke.status, 401, "ENG03: Revoked session must immediately receive 401 on attachment download");

    const idemAfterRevoke = await callApi(worker, env, "POST", "/api/v3/acq/signals", {
      token: trialB.token,
      orgId: trialB.ctx.org_id,
      idemKey: "idem_before_revoke",
      body: { source_platform: "facebook", acquisition_mode: "manual_discovery", demand_summary: "TEST signal before session revoke" },
    });
    assert.equal(idemAfterRevoke.status, 401, "ENG01: Revoked session must NEVER replay cached idempotency response!");

    console.log("PASS BLOCK 4 (ENG01/ENG03): Atomic op_id concurrent accept, expired lease recovery, post-revoke idempotency 401 & auth-proxied attachment revocation verified");
  }

  // =========================================================================
  // BLOCK 5 (ACQ01-12 + UX02-05 + REV07-08 + V4 Backup/Restore): 2+ Source E2E Loop & Honest Denominators
  // =========================================================================
  {
    // Create company in main org to test opt-out blocking & blind-dedupe deal reg
    const mainCmp = await callApi(worker, env, "POST", "/api/v3/companies", {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { canonical_name: "TEST Gulf Water Contracting LLC", country_en: "UAE", website_domain: "gulfwater.example.test" },
    });
    assert.equal(mainCmp.status, 201);
    const mainCmpId = mainCmp.data.company.id;

    // Task 1: Facebook manual_discovery (country_scope='ANY', 1.5h logged, spend=null)
    const fbTask = await callApi(worker, env, "POST", "/api/v3/acq/tasks", {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: {
        platform: "facebook",
        acquisition_mode: "manual_discovery",
        title: "TEST FB Round-1 Manual Discovery",
        country_scope: "ANY",
        hours_logged_tenths: 15,
        actual_spend_minor: null,
      },
    });
    assert.equal(fbTask.status, 201);

    // 3 FB signals: 1 valid (published_at null), 1 seller_ad, 1 pending_verify
    const fbSig1 = await callApi(worker, env, "POST", "/api/v3/acq/signals", {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: {
        task_id: fbTask.data.task.id,
        source_platform: "facebook",
        acquisition_mode: "manual_discovery",
        external_id: "fb_post_test_001",
        published_at: null, // ACQ04 unknown must remain NULL
        country_en: "UAE",
        product_line: "pe_pipes",
        buyer_role: "epc",
        demand_summary: "TEST Looking for supplier of HDPE PE100 DN200 PN16 pipes for water project in UAE",
      },
    });
    assert.equal(fbSig1.status, 201);
    assert.equal(fbSig1.data.signal.published_at, null, "Unknown published_at must remain NULL");
    assert.ok(fbSig1.data.signal.judgment_tags.reasons.length > 0, "Explainable judgment reasons required");

    const fbSigAd = await callApi(worker, env, "POST", "/api/v3/acq/signals", {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: {
        task_id: fbTask.data.task.id,
        source_platform: "facebook",
        acquisition_mode: "manual_discovery",
        demand_summary: "TEST We supply factory direct valves wholesale price DM us for catalog",
      },
    });
    assert.equal(fbSigAd.data.signal.judgment_tags.demandClarity, "suspected_seller_ad");

    const fbSigPending = await callApi(worker, env, "POST", "/api/v3/acq/signals", {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: {
        task_id: fbTask.data.task.id,
        source_platform: "facebook",
        acquisition_mode: "manual_discovery",
        demand_summary: "TEST General discussion about regional pipe specs pending verification",
      },
    });
    assert.equal(fbSigPending.status, 201);

    // Audit fbSig1 -> verified_valid + promote dev_lead; retry promote -> duplicateDispatchPrevented=true!
    const aud1 = await callApi(worker, env, "POST", `/api/v3/acq/signals/${fbSig1.data.signal.id}/audit`, {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { audit_status: "verified_valid", promote_to: "dev_lead", fulfillment_readiness: "direct_supply" },
    });
    assert.equal(aud1.status, 200);
    assert.ok(aud1.data.created_assignment_id);
    assert.equal(aud1.data.duplicateDispatchPrevented, false);

    const audDup = await callApi(worker, env, "POST", `/api/v3/acq/signals/${fbSig1.data.signal.id}/audit`, {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { audit_status: "verified_valid", promote_to: "dev_lead" },
    });
    assert.equal(audDup.data.duplicateDispatchPrevented, true, "ACQ06: Duplicate dispatch of same demand must be prevented");

    await callApi(worker, env, "POST", `/api/v3/acq/signals/${fbSigAd.data.signal.id}/audit`, {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { audit_status: "seller_ad", audit_reason: "Peer seller ad" },
    });

    // ACQ07/ACQ12: Draft + Copy MUST NOT increment manual_sent_count!
    const dr = await callApi(worker, env, "POST", `/api/v3/acq/signals/${fbSig1.data.signal.id}/draft`, {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { lang: "en" },
    });
    assert.equal(dr.status, 200);
    assert.equal(dr.data.approvedCatalogUsed, true);

    const cp = await callApi(worker, env, "POST", `/api/v3/acq/signals/${fbSig1.data.signal.id}/contact-action`, {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { action: "copied" },
    });
    assert.equal(cp.status, 200);
    assert.equal(cp.data.countedAsOutreach, false);
    assert.equal(cp.data.manual_sent_count, 0, "Copy MUST NOT count as outreach!");

    // Confirm manual send -> replied -> convert inquiry -> official quote!
    const ms = await callApi(worker, env, "POST", `/api/v3/acq/signals/${fbSig1.data.signal.id}/contact-action`, {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { action: "manual_sent" },
    });
    assert.equal(ms.status, 200);
    assert.equal(ms.data.countedAsOutreach, true);

    await callApi(worker, env, "POST", `/api/v3/acq/signals/${fbSig1.data.signal.id}/contact-action`, {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { action: "replied" },
    });
    const conv = await callApi(worker, env, "POST", `/api/v3/acq/signals/${fbSig1.data.signal.id}/contact-action`, {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { action: "convert_inquiry" },
    });
    assert.equal(conv.status, 201);
    const qt = await callApi(worker, env, "POST", `/api/v3/inquiries/${conv.data.inquiry_id}/quote`, {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { currency: "USD", total_minor: 4850000, incoterm: "CIF" },
    });
    assert.equal(qt.status, 201);

    // Opt-out priority test: linked company opted out -> blocks manual_sent with 409 OPT_OUT_BLOCKED!
    const optSig = await callApi(worker, env, "POST", "/api/v3/acq/signals", {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: {
        source_platform: "linkedin",
        acquisition_mode: "manual_discovery",
        linked_company_id: mainCmpId,
        demand_summary: "TEST LinkedIn procurement post from Gulf Water Contracting",
      },
    });
    await callApi(worker, env, "POST", `/api/v3/companies/${mainCmpId}/opt-out`, {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { level: "all_blocked", reason: "Buyer requested no outreach" },
    });
    const blockedSend = await callApi(worker, env, "POST", `/api/v3/acq/signals/${optSig.data.signal.id}/contact-action`, {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { action: "manual_sent" },
    });
    assert.equal(blockedSend.status, 409);
    assert.equal(blockedSend.data.code, "OPT_OUT_BLOCKED");

    // Add Instagram owned_account_inquiry + YouTube future candidate signal
    await callApi(worker, env, "POST", "/api/v3/acq/signals", {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: {
        source_platform: "instagram",
        acquisition_mode: "owned_account_inquiry",
        country_en: "Mexico",
        product_line: "cables",
        demand_summary: "TEST IG DM inquiry for XLPE power cables",
      },
    });
    await callApi(worker, env, "POST", "/api/v3/acq/signals", {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: {
        source_platform: "youtube",
        acquisition_mode: "manual_discovery",
        demand_summary: "TEST YouTube future candidate comment should NOT mix into round-1 stats",
      },
    });

    // ACQ10: Verify exact source comparison denominators & YouTube exclusion!
    const cmpRes = await callApi(worker, env, "GET", "/api/v3/acq/source-comparison", {
      token: adminToken,
      orgId: "org_friesgo_main",
    });
    assert.equal(cmpRes.status, 200);
    const fbGrp = cmpRes.data.groups.find((g) => g.source_platform === "facebook" && g.acquisition_mode === "manual_discovery");
    assert.ok(fbGrp, "FB manual_discovery group present");
    assert.equal(fbGrp.checked_candidates, 3);
    assert.equal(fbGrp.pending_verify_count, 1);
    assert.equal(fbGrp.verified_completed, 2);
    assert.equal(fbGrp.verified_valid, 1);
    assert.equal(fbGrp.verified_valid_rate_pct, 50);
    assert.equal(fbGrp.drafts_generated, 1);
    assert.equal(fbGrp.copies_count, 1);
    assert.equal(fbGrp.manual_outreach_count, 1);
    assert.equal(fbGrp.replied_count, 1);
    assert.equal(fbGrp.reply_rate_pct, 100);
    assert.equal(fbGrp.inquiries_count, 1);
    assert.equal(fbGrp.quoted_count, 1);
    assert.equal(fbGrp.hours_logged_tenths, 15);
    assert.equal(fbGrp.actual_spend_minor, null, "Unrecorded spend must stay null/unknown, never fake 0");
    assert.equal(fbGrp.spend_status, "unknown_not_recorded");
    assert.equal(fbGrp.small_sample_warning, true);
    assert.equal(cmpRes.data.groups.some((g) => g.source_platform === "youtube"), false, "YouTube MUST be excluded from round-1 groups");
    assert.equal(cmpRes.data.futureCandidates.length, 1);

    // REV07/08 Blind-Dedupe Deal Reg: Partner submits existing company -> neutral receipt; Manager sees duplicateHints!
    const drPtn = await callApi(worker, env, "POST", "/api/v3/partner/deal-reg", {
      token: partnerUser.token,
      orgId: "org_friesgo_main",
      idemKey: "idem_dr_blind_1",
      body: {
        reg_tier: "demand_reg",
        company_name: "TEST Gulf Water Contracting LLC",
        country_en: "UAE",
        demand_evidence: "Buyer asked for DN200 valves",
      },
    });
    assert.equal(drPtn.status, 201);
    assert.equal(drPtn.data.registration.status, "pending_audit");
    assert.equal(drPtn.data.registration.duplicateHints, undefined, "REV07: Partner must NOT receive duplicate hints");

    const drMgrList = await callApi(worker, env, "GET", "/api/v3/partner/deal-reg", {
      token: adminToken,
      orgId: "org_friesgo_main",
    });
    const matchedReg = drMgrList.data.registrations.find((r) => r.id === drPtn.data.registration.id);
    assert.ok(matchedReg.duplicateHints.length >= 1, "Manager MUST see duplicate collision hints");

    // REV08: Approve while protectionDays is null (TBD) -> intake_receipt (NO fabricated expiry!)
    const revIntake = await callApi(worker, env, "PATCH", `/api/v3/deal-reg/${matchedReg.id}/review`, {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { decision: "approve", review_note: "Confirmed submission facts" },
    });
    assert.equal(revIntake.status, 200);
    assert.equal(revIntake.data.receipt_type, "intake_receipt");
    assert.equal(revIntake.data.protection_expires_at, null);

    // Approve with explicit policy protection days -> protection_record with cert & SHA-256!
    const revProt = await callApi(worker, env, "PATCH", `/api/v3/deal-reg/${matchedReg.id}/review`, {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { decision: "approve", override_protection_days: 90, policy_version: "TEST-POL-1" },
    });
    assert.equal(revProt.status, 200);
    assert.equal(revProt.data.receipt_type, "protection_record");
    assert.ok(revProt.data.protection_cert_no.startsWith("FG-CERT-"));
    assert.equal(revProt.data.canonical_sha256.length, 64);

    // V4 Backup & Restore drill covering all 14 new V3 Slice-1 tables
    const exp = await callApi(worker, env, "POST", "/api/admin/export-backup", {
      token: adminToken,
      body: { totp_code: await getAdminTotp() },
    });
    assert.equal(exp.status, 200);
    assert.equal(exp.data.schemaVersion, 4);
    assert.ok(exp.data.counts.demand_signals >= 5);
    assert.ok(exp.data.counts.deal_registrations >= 2);

    // Delete a signal locally, then restore from backup and verify reconciliation + post-restore-verify unfreeze!
    db.raw.prepare("DELETE FROM demand_signals WHERE id = ?").run(fbSigPending.data.signal.id);
    const rst = await callApi(worker, env, "POST", "/api/admin/restore-backup", {
      token: adminToken,
      body: {
        totp_code: await getAdminTotp(),
        confirmPhrase: "RESTORE_CONFIRM",
        snapshotSha256: exp.data.snapshotSha256,
        counts: exp.data.counts,
        tables: exp.data.tables,
      },
    });
    assert.equal(rst.status, 200);
    assert.equal(rst.data.reconciled, true);

    const unfreeze = await callApi(worker, env, "POST", "/api/admin/post-restore-verify", {
      token: adminToken,
      body: { totp_code: await getAdminTotp(), revokeOtherSessions: false },
    });
    assert.equal(unfreeze.status, 200);
    assert.equal(unfreeze.data.report.restoreFreezeCleared, true);

    const sigBack = db.raw.prepare("SELECT id FROM demand_signals WHERE id = ?").get(fbSigPending.data.signal.id);
    assert.ok(sigBack && sigBack.id === fbSigPending.data.signal.id, "V4 Slice-1 table row must be fully restored");

    console.log("PASS BLOCK 5 (ACQ01-12/UX02-05/REV07-08/V4-Backup): Multi-source funnel, honest denominators, YouTube exclusion, opt-out block, blind-dedupe deal reg & V4 backup/restore verified");
  }

  // =========================================================================
  // BLOCK 6 (Real Headless Chrome): rfq.html, join.html & index.html REV01 contextEpoch Stale-Response Discard
  // =========================================================================
  let delayNextCompaniesMs = 0;
  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, "http://127.0.0.1");
    if (reqUrl.pathname.startsWith("/api/")) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const rawBody = Buffer.concat(chunks);
      if (reqUrl.pathname === "/api/v3/companies" && delayNextCompaniesMs > 0) {
        const d = delayNextCompaniesMs;
        delayNextCompaniesMs = 0;
        await sleep(d);
      }
      const wReq = new Request(`http://127.0.0.1${reqUrl.pathname}${reqUrl.search}`, {
        method: req.method,
        headers: req.headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : rawBody,
      });
      const wResp = await worker.fetch(wReq, env);
      res.writeHead(wResp.status, Object.fromEntries(wResp.headers.entries()));
      const buf = Buffer.from(await wResp.arrayBuffer());
      res.end(buf);
      return;
    }
    const cleanPath = reqUrl.pathname === "/" ? "/index.html" : reqUrl.pathname;
    const filePath = path.join(ROOT, cleanPath.replace(/^\/+/, ""));
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const mime = ext === ".html" ? "text/html; charset=utf-8" : ext === ".js" ? "application/javascript; charset=utf-8" : ext === ".png" ? "image/png" : "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime });
      res.end(fs.readFileSync(filePath));
      return;
    }
    res.writeHead(404);
    res.end("Not Found");
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  // Allow public browser pages to submit without Turnstile widget in local Chrome test
  env.TURNSTILE_SECRET_KEY = "";

  const chrome = await launchChromePage(`${baseUrl}/rfq.html?api=${encodeURIComponent(baseUrl)}&ref=DISABLED_TEST_REF`);
  try {
    // 6.1 rfq.html: Zero recruitment words (REV10), minimal 3-field submit works smoothly
    const rfqCheck = await chrome.evalJs(`(async () => {
      const bodyTxt = document.body.innerText;
      const hasRecruitText = /加盟|合伙人|招商|代理返佣|招聘/i.test(bodyTxt);
      document.getElementById("rfqDemand").value = "TEST Browser RFQ: need HDPE PE100 pipe DN250 for municipal project";
      document.getElementById("rfqCountry").value = "Vietnam";
      document.getElementById("rfqContactVal").value = "browser.buyer@example.test";
      document.getElementById("rfqPrivacyConsent").checked = true;
      document.getElementById("btnSubmitRfq").click();
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (!document.getElementById("rfqSuccessBox").hidden) break;
      }
      return {
        hasRecruitText,
        refBannerHidden: document.getElementById("refBanner").hidden,
        successText: document.getElementById("rfqSuccessBox").innerText
      };
    })()`);
    assert.equal(rfqCheck.hasRecruitText, false, "REV10: rfq.html must contain zero partner/recruitment text");
    assert.equal(rfqCheck.refBannerHidden, true, "REV06: Invalid/disabled ref must stay hidden/neutral");
    assert.ok(rfqCheck.successText.includes("FG-RFQ-"), "Buyer RFQ must render FG-RFQ receipt");

    // 6.2 join.html: 3-way form + one-time lookup secret + live status check
    await chrome.navigate(`${baseUrl}/join.html?api=${encodeURIComponent(baseUrl)}`);
    const joinCheck = await chrome.evalJs(`(async () => {
      const marketingDefault = document.getElementById("marketingOptIn").checked;
      document.getElementById("appName").value = "TEST Chrome Partner";
      document.getElementById("contactValue").value = "chrome_partner_wx";
      document.getElementById("privacyConsent").checked = true;
      document.getElementById("btnSubmitJoin").click();
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (!document.getElementById("joinSuccessBox").hidden) break;
      }
      const receipt = document.getElementById("joinSuccessBox").innerText;
      document.getElementById("tabBtnStatus").click();
      document.getElementById("btnCheckStatus").click();
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (!document.getElementById("statusResultBox").hidden) break;
      }
      return {
        marketingDefault,
        receipt,
        statusOut: document.getElementById("statusResultBox").innerText
      };
    })()`);
    assert.equal(joinCheck.marketingDefault, false, "Marketing opt-in must default unchecked");
    assert.ok(joinCheck.receipt.includes("FG-APP-") && joinCheck.receipt.includes("fglk_"));
    assert.ok(joinCheck.statusOut.includes("FG-APP-"));

    // 6.3 index.html: Real Chrome login + REV01 contextEpoch + AbortController stale-response discard + scoped draft isolation + V3 Hub render
    await chrome.navigate(`${baseUrl}/index.html`);
    const liveTotpForChrome = await getAdminTotp();
    delayNextCompaniesMs = 450;
    const epochCheck = await chrome.evalJs(`(async () => {
      window.FG_CLOUD.setApiBase(${JSON.stringify(baseUrl)});
      const loginRes = await window.FG_CLOUD.login("test_admin", "TestAdmin2026!", ${JSON.stringify(liveTotpForChrome)}, "Chrome V3 Test");
      if (!loginRes || !loginRes.ok) throw new Error("Chrome login failed: " + JSON.stringify(loginRes));

      // Switch to Org Main, save scoped draft, start slow request, then switch context mid-flight!
      window.FG_V3.switchContext({ org_id: "org_friesgo_main", org_type: "company_main", org_name: "FriesGo Global", role: "super_admin", membership_id: "legacy_main" });
      window.FG_V3.saveScopedDraft("signal", { demand_summary: "MAIN_ORG_SECRET_DRAFT" });
      const epochBefore = window.FG_V3.getContextEpoch();

      const slowPromise = window.FG_V3.listCompanies();
      await new Promise((r) => setTimeout(r, 60));
      // Switch to another org mid-flight -> MUST abort/discard slowPromise AND isolate drafts!
      window.FG_V3.switchContext({ org_id: "org_other_iso", org_type: "independent_trial", org_name: "Other Org", role: "independent_user", membership_id: "mem_other" });
      const slowRes = await slowPromise;
      const otherDraft = window.FG_V3.loadScopedDraft("signal");

      // Switch back to main org & open V3 Growth Hub UI
      window.FG_V3.switchContext({ org_id: "org_friesgo_main", org_type: "company_main", org_name: "FriesGo Global", role: "super_admin", membership_id: "legacy_main" });
      const mainDraftRestored = window.FG_V3.loadScopedDraft("signal");
      await window.FG_V3_UI.openHub("compare");
      await new Promise((r) => setTimeout(r, 350));
      const hubText = document.getElementById("v3GrowthHubBackdrop").innerText;
      return {
        epochBefore,
        epochAfter: window.FG_V3.getContextEpoch(),
        slowRes,
        otherDraft,
        mainDraftRestored,
        hubHasFbCompare: hubText.includes("facebook") && hubText.includes("manual_discovery")
      };
    })()`);
    assert.equal(epochCheck.slowRes.staleContext, true, "REV01: Stale in-flight response MUST be discarded on context switch");
    assert.equal(epochCheck.slowRes.code, "STALE_CONTEXT_DISCARDED");
    assert.equal(epochCheck.otherDraft, null, "ACQ04: Draft from Org Main MUST NOT leak into Other Org");
    assert.equal(epochCheck.mainDraftRestored.demand_summary, "MAIN_ORG_SECRET_DRAFT");
    assert.equal(epochCheck.hubHasFbCompare, true, "V3 Growth Hub must render live FB source comparison table");
    assert.equal(chrome.pageErrors.length, 0, "Zero uncaught Chrome pageErrors: " + chrome.pageErrors.join(" | "));

    console.log("PASS BLOCK 6 (Real Headless Chrome): rfq.html, join.html, index.html V3 Hub, REV01 contextEpoch stale-response discard, ACQ04 scoped drafts & 0 pageErrors verified");
  } finally {
    await chrome.close();
    server.close();
  }

  console.log("\nALL V3 SLICE-1 DIRECTED VERIFICATION BLOCKS (1–6) PASSED!");
}

main().catch((err) => {
  console.error("V3 SLICE-1 VERIFICATION FAILED:", err);
  process.exit(1);
});
