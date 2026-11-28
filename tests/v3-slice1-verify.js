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

    // 1.9 N05: Reject floats, scientific notation, non-integer strings, NaN/Infinity, null/boolean & unsafe integer strings BEFORE Number() truncation!
    const exactIntErrRe = /INVALID_EXACT_INTEGER|INVALID_INTEGER|UNSAFE_INTEGER|D1_SAFE_INT_OVERFLOW|NEGATIVE_NOT_ALLOWED/;
    for (const badVal of [1.99, "1.99", NaN, Infinity, -Infinity, "1e5", "9007199254740993", "-9007199254740993", null, true, false, ""]) {
      assert.throws(
        () => moneyMod.convertCurrencyMinor({ sourceMinor: badVal, sourceCurrency: "USD", targetCurrency: "EUR", fxRateDec: "0.92" }),
        exactIntErrRe,
        `convertCurrencyMinor must reject bad input ${String(badVal)}`
      );
      assert.throws(
        () => moneyMod.calculateLineCommissionMinor({ calcMode: "pct_of_commissionable", currency: "USD", commissionableMinor: badVal, ratePpm: 50000 }),
        exactIntErrRe,
        `calculateLineCommissionMinor(commissionableMinor) must reject ${String(badVal)}`
      );
      assert.throws(
        () => moneyMod.calculateLineCommissionMinor({ calcMode: "pct_of_commissionable", currency: "USD", commissionableMinor: 1000, ratePpm: badVal }),
        exactIntErrRe,
        `calculateLineCommissionMinor(ratePpm) must reject ${String(badVal)}`
      );
      assert.throws(
        () => moneyMod.splitCommissionLargestRemainder({ totalCommissionMinor: badVal, shares: [{ id: "p1", rolePriority: 1, weightPpm: 1000000 }] }),
        exactIntErrRe,
        `splitCommissionLargestRemainder must reject totalCommissionMinor=${String(badVal)}`
      );
      assert.throws(
        () => moneyMod.formatMinor(badVal, "USD"),
        exactIntErrRe,
        `formatMinor must reject ${String(badVal)}`
      );
    }
    assert.throws(
      () => moneyMod.splitCommissionLargestRemainder({ totalCommissionMinor: 100, shares: [{ id: "p1", rolePriority: 1, weightPpm: 1000.5 }] }),
      exactIntErrRe
    );
    console.log("PASS BLOCK 1 (ENG02/N05): JPY<->USD cross-decimal FX, $0.03/4 Largest-Remainder, negative symmetry, retained vs unallocated, fixed_per_unit, D1 safe-int & N05 strict integer guards verified");
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
  let mainCmpId = "";
  let mainInquiryId = "";
  {
    // Create company in main org to test opt-out blocking & blind-dedupe deal reg
    const mainCmp = await callApi(worker, env, "POST", "/api/v3/companies", {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { canonical_name: "TEST Gulf Water Contracting LLC", country_en: "UAE", website_domain: "gulfwater.example.test" },
    });
    assert.equal(mainCmp.status, 201);
    mainCmpId = mainCmp.data.company.id;

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

    // Confirm manual send -> replied -> convert inquiry -> draft quote (S06) -> confirmed official quote!
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
    mainInquiryId = conv.data.inquiry_id;

    // S06: Without confirm_approved=true, quote defaults to unconfirmed draft (does NOT advance inquiry to quoted!)
    const qtDraft = await callApi(worker, env, "POST", `/api/v3/inquiries/${mainInquiryId}/quote`, {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { currency: "USD", total_minor: 4800000, incoterm: "FOB" },
    });
    assert.equal(qtDraft.status, 201);
    assert.equal(qtDraft.data.sent_confirmed, 0, "S06: Quote must default to sent_confirmed=0 draft");
    assert.equal(qtDraft.data.status, "rfq_in_progress", "S06: Draft quote must not mark inquiry as quoted");

    // S06: Manager explicitly confirms approved quote -> sent_confirmed=1 & status='quoted'
    const qt = await callApi(worker, env, "POST", `/api/v3/inquiries/${mainInquiryId}/quote`, {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { currency: "USD", total_minor: 4850000, incoterm: "CIF", confirm_approved: true },
    });
    assert.equal(qt.status, 201);
    assert.equal(qt.data.sent_confirmed, 1);
    assert.equal(qt.data.status, "quoted");

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
  // BLOCK 6 (S01–S08): Security & State Consistency Remediation Verification (Positive + Negative)
  // =========================================================================
  let partnerAssignedSigId = "";
  let validDeepLinkTodoId = "";
  {
    // --- S01: Legacy V2.1 API Multi-Tenant Isolation ---
    for (const [m, p] of [
      ["GET", "/api/companies"],
      ["POST", "/api/companies"],
      ["GET", "/api/osm-pool"],
      ["GET", "/api/events/recent"],
      ["GET", "/api/scrape-tasks"],
      ["GET", "/api/feedback"],
      ["GET", "/api/gmaps/quota"],
      ["GET", "/api/admin/employees"],
    ]) {
      const rTrial = await callApi(worker, env, m, p, {
        token: trialA.token,
        body: m === "POST" ? { name: "Illegal Trial Legacy Write", country: "US" } : undefined,
      });
      assert.equal(rTrial.status, 403, `S01: trialA calling ${m} ${p} MUST return 403 (got ${rTrial.status})`);
      if (p.startsWith("/api/admin/")) {
        assert.match(String(rTrial.data.code || ""), /^(FORBIDDEN_LEGACY_POOL|FORBIDDEN_ROLE)$/);
      } else {
        assert.equal(rTrial.data.code, "FORBIDDEN_LEGACY_POOL", `S01: trialA calling ${m} ${p} must return FORBIDDEN_LEGACY_POOL`);
      }
    }
    for (const p of ["/api/companies", "/api/events/recent", "/api/admin/employees"]) {
      const rPtn = await callApi(worker, env, "GET", p, { token: partnerUser.token });
      assert.equal(rPtn.status, 403, `S01: partnerUser calling GET ${p} MUST return 403`);
      if (p.startsWith("/api/admin/")) {
        assert.match(String(rPtn.data.code || ""), /^(FORBIDDEN_LEGACY_POOL|FORBIDDEN_ROLE)$/);
      } else {
        assert.equal(rPtn.data.code, "FORBIDDEN_LEGACY_POOL");
      }
    }
    // super_admin on legacy /api/companies ONLY sees org_friesgo_main — NEVER trialA/trialB companies!
    const admLegacyList = await callApi(worker, env, "GET", "/api/companies", { token: adminToken });
    assert.equal(admLegacyList.status, 200);
    const admLegacyIds = (admLegacyList.data.companies || []).map((c) => c.id);
    assert.equal(admLegacyIds.includes(trialACompanyId), false, "S01: trialA company must NEVER appear in legacy /api/companies");
    assert.equal(admLegacyIds.includes(trialBCompanyId), false, "S01: trialB company must NEVER appear in legacy /api/companies");
    assert.equal((await callApi(worker, env, "GET", `/api/companies/${trialACompanyId}`, { token: adminToken })).status, 404);
    assert.equal((await callApi(worker, env, "PATCH", `/api/companies/${trialACompanyId}`, { token: adminToken, body: { stage: "contacted" } })).status, 404);
    assert.equal((await callApi(worker, env, "POST", `/api/companies/${trialACompanyId}/lock`, { token: adminToken, body: {} })).status, 404);
    assert.equal((await callApi(worker, env, "GET", `/api/companies/${trialACompanyId}/events`, { token: adminToken })).status, 404);
    const admWrongHdr = await callApi(worker, env, "GET", "/api/companies", { token: adminToken, orgId: trialA.ctx.org_id });
    assert.equal(admWrongHdr.status, 403, "S01: Legacy /api/companies must reject non-main X-FG-Org-Id");
    assert.equal(admWrongHdr.data.code, "FORBIDDEN_LEGACY_POOL");

    // --- S02: Disabled org_memberships Fail-Closed (Zero Fallback to org_friesgo_main) ---
    const disApp = await callApi(worker, env, "POST", "/api/public/applications", {
      idemKey: "idem_s02_disabled_mem_app",
      body: {
        app_type: "partner",
        partner_mode: "followup",
        applicant_name: "TEST S02 Disabled Membership User",
        contact_channel: "email",
        contact_value: "s02.disabled@example.test",
        privacyConsent: true,
        turnstile_token: "ts_once_s02_app",
      },
    });
    assert.equal(disApp.status, 201);
    const disApps = await callApi(worker, env, "GET", "/api/v3/applications", { token: adminToken, orgId: "org_friesgo_main" });
    const disAppRow = disApps.data.applications.find((a) => a.application_no === disApp.data.application_no);
    await callApi(worker, env, "PATCH", `/api/v3/applications/${disAppRow.id}`, {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { status: "approved", quiz_score: 100, quiz_passed: true },
    });
    await callApi(worker, env, "POST", `/api/v3/applications/${disAppRow.id}/activate`, {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { login_id: "test_s02_disabled", initial_password: "TestUser2026!" },
    });
    const s02User = await loginAs("test_s02_disabled");
    assert.ok(s02User.ctx && s02User.ctx.org_id === "org_friesgo_main");
    // Disable org_memberships while keeping employees.status = 'active'
    db.raw.prepare("UPDATE org_memberships SET status = 'disabled' WHERE employee_id = ?").run(s02User.empId);
    const s02Ctxs = await callApi(worker, env, "GET", "/api/v3/me/contexts", { token: s02User.token });
    assert.equal(s02Ctxs.status, 200);
    assert.equal(s02Ctxs.data.contexts.length, 0, "S02: Disabled membership must return empty contexts (never fallback to main)");
    const s02V3 = await callApi(worker, env, "GET", "/api/v3/companies", { token: s02User.token, orgId: "org_friesgo_main" });
    assert.equal(s02V3.status, 403);
    assert.equal(s02V3.data.code, "ORG_MEMBERSHIP_DISABLED");
    const s02Legacy = await callApi(worker, env, "GET", "/api/companies", { token: s02User.token });
    assert.equal(s02Legacy.status, 403);
    assert.equal(s02Legacy.data.code, "ORG_MEMBERSHIP_DISABLED");

    // --- S03: Partner Signal Authorization on /draft and /contact-action ---
    const admPrivSigRes = await callApi(worker, env, "POST", "/api/v3/acq/signals", {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: {
        source_platform: "facebook",
        acquisition_mode: "manual_discovery",
        country_en: "Qatar",
        product_line: "valves",
        demand_summary: "TEST S03 Private main-org signal NOT assigned to partnerUser",
      },
    });
    assert.equal(admPrivSigRes.status, 201);
    const admPrivSigId = admPrivSigRes.data.signal.id;

    const ptnDraftDeny = await callApi(worker, env, "POST", `/api/v3/acq/signals/${admPrivSigId}/draft`, {
      token: partnerUser.token,
      orgId: "org_friesgo_main",
      body: { lang: "en" },
    });
    assert.equal(ptnDraftDeny.status, 404, "S03: Partner must get 404 on unassigned signal /draft");
    assert.equal(ptnDraftDeny.data.code, "SIGNAL_NOT_FOUND");

    const ptnActionDeny1 = await callApi(worker, env, "POST", `/api/v3/acq/signals/${admPrivSigId}/contact-action`, {
      token: partnerUser.token,
      orgId: "org_friesgo_main",
      body: { action: "manual_sent" },
    });
    assert.equal(ptnActionDeny1.status, 404);
    assert.equal(ptnActionDeny1.data.code, "SIGNAL_NOT_FOUND");

    const ptnActionDeny2 = await callApi(worker, env, "POST", `/api/v3/acq/signals/${admPrivSigId}/contact-action`, {
      token: partnerUser.token,
      orgId: "org_friesgo_main",
      body: { action: "opted_out" },
    });
    assert.equal(ptnActionDeny2.status, 404);
    const privRow = db.raw
      .prepare("SELECT draft_count, copy_count, manual_sent_count, opt_out_locked, contact_result FROM demand_signals WHERE id = ?")
      .get(admPrivSigId);
    assert.deepEqual(
      {
        draft_count: Number(privRow.draft_count),
        copy_count: Number(privRow.copy_count),
        manual_sent_count: Number(privRow.manual_sent_count),
        opt_out_locked: Number(privRow.opt_out_locked),
        contact_result: privRow.contact_result,
      },
      { draft_count: 0, copy_count: 0, manual_sent_count: 0, opt_out_locked: 0, contact_result: "to_contact" },
      "S03: Unauthorized partner calls must NOT mutate signal counters or state"
    );

    // Positive S03 check: signal promoted & assigned to partnerUser CAN be drafted/acted by partnerUser
    const ptnAssignedSigRes = await callApi(worker, env, "POST", "/api/v3/acq/signals", {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: {
        source_platform: "facebook",
        acquisition_mode: "manual_discovery",
        country_en: "Oman",
        product_line: "pe_pipes",
        demand_summary: "TEST S03 Signal assigned to partnerUser for authorized action check",
      },
    });
    partnerAssignedSigId = ptnAssignedSigRes.data.signal.id;
    const ptnAud = await callApi(worker, env, "POST", `/api/v3/acq/signals/${partnerAssignedSigId}/audit`, {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { audit_status: "verified_valid", promote_to: "dev_lead" },
    });
    assert.equal(ptnAud.status, 200);
    validDeepLinkTodoId = ptnAud.data.created_assignment_id;
    const ptnAssign = await callApi(worker, env, "POST", "/api/v3/dispatch/assign", {
      token: adminToken,
      orgId: "org_friesgo_main",
      idemKey: "idem_s03_assign_ptn",
      body: { assignment_id: validDeepLinkTodoId, assignee_employee_id: partnerUser.empId, accept_hours: 24 },
    });
    assert.equal(ptnAssign.status, 200);
    const ptnDraftOk = await callApi(worker, env, "POST", `/api/v3/acq/signals/${partnerAssignedSigId}/draft`, {
      token: partnerUser.token,
      orgId: "org_friesgo_main",
      body: { lang: "en" },
    });
    assert.equal(ptnDraftOk.status, 200, "S03 positive: Partner CAN draft on explicitly assigned signal");

    // --- S04: Attachment Visibility & Entity-Level Authorization ---
    const att1 = await callApi(worker, env, "POST", "/api/v3/attachments", {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { entity_type: "demand_signal", entity_id: admPrivSigId, filename: "internal_cost_sheet.txt", content_text: "INTERNAL COST ONLY" },
    });
    assert.equal(att1.status, 201);
    assert.equal(att1.data.attachment.visibility, "internal_only", "S04: Internal uploads must default to internal_only");

    const att2 = await callApi(worker, env, "POST", "/api/v3/attachments", {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { entity_type: "demand_signal", entity_id: admPrivSigId, visibility: "org_authorized", filename: "unassigned_shared.txt", content_text: "UNASSIGNED SHARED" },
    });
    assert.equal(att2.status, 201);

    const att3 = await callApi(worker, env, "POST", "/api/v3/attachments", {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { entity_type: "demand_signal", entity_id: partnerAssignedSigId, visibility: "internal_only", filename: "assigned_internal_margin.txt", content_text: "INTERNAL MARGIN" },
    });
    assert.equal(att3.status, 201);

    const att4 = await callApi(worker, env, "POST", "/api/v3/attachments", {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { entity_type: "demand_signal", entity_id: partnerAssignedSigId, visibility: "org_authorized", filename: "assigned_buyer_spec.txt", content_text: "PARTNER AUTHORIZED SPEC" },
    });
    assert.equal(att4.status, 201);

    // Partner MUST get 404 on att1, att2 (unassigned entity!), and att3 (internal_only even on assigned entity!)
    assert.equal((await callApi(worker, env, "GET", `/api/v3/attachments/${att1.data.attachment.id}`, { token: partnerUser.token, orgId: "org_friesgo_main" })).status, 404);
    assert.equal((await callApi(worker, env, "GET", `/api/v3/attachments/${att2.data.attachment.id}`, { token: partnerUser.token, orgId: "org_friesgo_main" })).status, 404);
    assert.equal((await callApi(worker, env, "GET", `/api/v3/attachments/${att3.data.attachment.id}`, { token: partnerUser.token, orgId: "org_friesgo_main" })).status, 404);
    // Partner CAN download att4 (org_authorized + assigned signal)
    const att4PtnOk = await callApi(worker, env, "GET", `/api/v3/attachments/${att4.data.attachment.id}`, { token: partnerUser.token, orgId: "org_friesgo_main" });
    assert.equal(att4PtnOk.status, 200);
    assert.equal(att4PtnOk.data, "PARTNER AUTHORIZED SPEC");

    // --- S05: Persistent Monotonic Signal Opt-Out Lock (Even Without linked_company_id) & Audited Reconsent ---
    const unlinkedOptRes = await callApi(worker, env, "POST", "/api/v3/acq/signals", {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: {
        source_platform: "instagram",
        acquisition_mode: "manual_discovery",
        demand_summary: "TEST S05 Unlinked signal opt-out lock test",
      },
    });
    const unlinkedOptId = unlinkedOptRes.data.signal.id;
    const markOpt = await callApi(worker, env, "POST", `/api/v3/acq/signals/${unlinkedOptId}/contact-action`, {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { action: "opted_out", note: "Buyer explicitly said do not contact" },
    });
    assert.equal(markOpt.status, 200);
    assert.equal(markOpt.data.opt_out_locked, 1);

    for (const blockedAct of ["replied", "manual_sent", "need_specs", "waiting_reply", "paused", "invalid", "convert_inquiry", "copied"]) {
      const rBlk = await callApi(worker, env, "POST", `/api/v3/acq/signals/${unlinkedOptId}/contact-action`, {
        token: adminToken,
        orgId: "org_friesgo_main",
        body: { action: blockedAct },
      });
      assert.equal(rBlk.status, 409, `S05: Action '${blockedAct}' MUST be blocked 409 after opted_out (even when unlinked)`);
      assert.equal(rBlk.data.code, "OPT_OUT_BLOCKED");
    }
    const stillLocked = db.raw.prepare("SELECT opt_out_locked, contact_result FROM demand_signals WHERE id = ?").get(unlinkedOptId);
    assert.equal(Number(stillLocked.opt_out_locked), 1);
    assert.equal(stillLocked.contact_result, "opted_out");

    // Reconsent negative checks (partner 403, missing evidence 400) + positive audited manager reconsent (200)
    const reconPtn = await callApi(worker, env, "POST", `/api/v3/acq/signals/${unlinkedOptId}/reconsent`, {
      token: partnerUser.token,
      orgId: "org_friesgo_main",
      body: { reason: "Attempt", consent_evidence: "None" },
    });
    assert.equal(reconPtn.status, 403);
    const reconNoEv = await callApi(worker, env, "POST", `/api/v3/acq/signals/${unlinkedOptId}/reconsent`, {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { reason: "Missing evidence" },
    });
    assert.equal(reconNoEv.status, 400);
    assert.equal(reconNoEv.data.code, "RECONSENT_EVIDENCE_REQUIRED");
    const reconOk = await callApi(worker, env, "POST", `/api/v3/acq/signals/${unlinkedOptId}/reconsent`, {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { reason: "Buyer re-initiated inquiry via official email", consent_evidence: "Email ref MSG-2026-1128" },
    });
    assert.equal(reconOk.status, 200);
    assert.equal(reconOk.data.opt_out_locked, 0);
    const afterReconAction = await callApi(worker, env, "POST", `/api/v3/acq/signals/${unlinkedOptId}/contact-action`, {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { action: "copied" },
    });
    assert.equal(afterReconAction.status, 200);

    // --- S06: Inquiry Quote Validation, Internal Cost Field Stripping & Opt-Out Check ---
    assert.equal(
      (await callApi(worker, env, "POST", `/api/v3/inquiries/${mainInquiryId}/quote`, {
        token: adminToken,
        orgId: "org_friesgo_main",
        body: { currency: "ZZZ", total_minor: 10000, incoterm: "FOB" },
      })).status,
      400
    );
    assert.equal(
      (await callApi(worker, env, "POST", `/api/v3/inquiries/${mainInquiryId}/quote`, {
        token: adminToken,
        orgId: "org_friesgo_main",
        body: { currency: "USD", total_minor: -500, incoterm: "FOB" },
      })).status,
      400
    );
    assert.equal(
      (await callApi(worker, env, "POST", `/api/v3/inquiries/${mainInquiryId}/quote`, {
        token: adminToken,
        orgId: "org_friesgo_main",
        body: { currency: "USD", total_minor: 12.34, incoterm: "FOB" },
      })).status,
      400
    );
    assert.equal(
      (await callApi(worker, env, "POST", `/api/v3/inquiries/${mainInquiryId}/quote`, {
        token: adminToken,
        orgId: "org_friesgo_main",
        body: { currency: "USD", total_minor: 10000, incoterm: "INVALID_TERM" },
      })).status,
      400
    );
    assert.equal(
      (await callApi(worker, env, "POST", `/api/v3/inquiries/${mainInquiryId}/quote`, {
        token: partnerUser.token,
        orgId: "org_friesgo_main",
        body: { currency: "USD", total_minor: 10000, incoterm: "FOB", confirm_approved: true },
      })).status,
      403
    );
    const qtStrip = await callApi(worker, env, "POST", `/api/v3/inquiries/${mainInquiryId}/quote`, {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: {
        currency: "USD",
        total_minor: 250000,
        incoterm: "FOB",
        factoryRmb: 99999,
        supplierCost: 88888,
        marginPct: 42,
        items: [
          {
            sku: "VLV-200",
            description: "API 600 Gate Valve DN200",
            qty: 5,
            unit: "pcs",
            unit_price_minor: 50000,
            factoryRmb: 12000,
            supplierCost: 9000,
            marginPct: 38,
            internalCost: 8500,
          },
        ],
      },
    });
    assert.equal(qtStrip.status, 201);
    const savedQuoteRow = db.raw.prepare("SELECT payload_json, sent_confirmed FROM quote_records WHERE quote_id = ?").get(qtStrip.data.quote_id);
    assert.equal(Number(savedQuoteRow.sent_confirmed), 0);
    for (const forbiddenKey of ["factoryRmb", "supplierCost", "marginPct", "internalCost"]) {
      assert.equal(savedQuoteRow.payload_json.includes(forbiddenKey), false, `S06: Saved quote payload_json must NEVER contain ${forbiddenKey}`);
    }

    // Quote on inquiry linked to opted-out company -> 409 OPT_OUT_BLOCKED
    const optInqId = `inq_s06_opt_${Date.now()}`;
    db.raw
      .prepare(
        `INSERT INTO inquiries (id, org_id, inquiry_no, company_id, summary, product_line, country_en, status, created_by, created_at, updated_at)
         VALUES (?, 'org_friesgo_main', ?, ?, 'TEST Opted-Out Company Inquiry', 'valves', 'UAE', 'rfq_in_progress', ?, ?, ?)`
      )
      .run(optInqId, `FG-INQ-S06-${Date.now()}`, mainCmpId, adminId, new Date().toISOString(), new Date().toISOString());
    const qtOptBlocked = await callApi(worker, env, "POST", `/api/v3/inquiries/${optInqId}/quote`, {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { currency: "USD", total_minor: 50000, incoterm: "FOB" },
    });
    assert.equal(qtOptBlocked.status, 403, "S06: Quote for opted-out company MUST be blocked 403");
    assert.equal(qtOptBlocked.data.code, "COMPLIANCE_OR_OPTOUT_BLOCKED");

    // --- S07: V3_SLICE1_ENABLED Feature Flag Fail-Closed ---
    for (const disabledVal of ["0", undefined, ""]) {
      const envOff = makeEnv(db, { V3_SLICE1_ENABLED: disabledVal });
      const hOff = await callApi(worker, envOff, "GET", "/api/health");
      assert.equal(hOff.status, 200);
      assert.equal(hOff.data.v3Slice1Enabled, false);
      for (const [m, p] of [
        ["GET", "/api/public/catalog"],
        ["POST", "/api/public/applications"],
        ["POST", "/api/public/rfq"],
        ["GET", "/api/v3/me/contexts"],
        ["GET", "/api/v3/acq/signals"],
      ]) {
        const rOff = await callApi(worker, envOff, m, p, { token: adminToken, orgId: "org_friesgo_main", body: m === "POST" ? {} : undefined });
        assert.equal(rOff.status, 503, `S07: ${m} ${p} MUST return 503 when V3_SLICE1_ENABLED=${String(disabledVal)}`);
        assert.equal(rOff.data.code, "V3_FEATURE_DISABLED");
      }
      // Legacy V2.1 stays 200 when V3 flag is OFF
      const legacyStillOk = await callApi(worker, envOff, "GET", "/api/companies", { token: adminToken });
      assert.equal(legacyStillOk.status, 200, "S07: Legacy V2.1 API must remain 200 when V3 flag is OFF");
    }
    // N01 / S07: Validate ONLY tracked secret-free template (never depend on gitignored local wrangler.toml!)
    const wranglerExample = fs.readFileSync(path.join(ROOT, "workers/friesgo-api/wrangler.example.toml"), "utf8");
    assert.match(wranglerExample, /\[vars\][\s\S]*?V3_SLICE1_ENABLED\s*=\s*"0"/, "S07/N01: Tracked wrangler.example.toml [vars] must declare V3_SLICE1_ENABLED = \"0\"");
    assert.match(wranglerExample, /\[env\.staging\.vars\][\s\S]*?V3_SLICE1_ENABLED\s*=\s*"1"/, "S07/N01: Tracked wrangler.example.toml [env.staging.vars] must declare V3_SLICE1_ENABLED = \"1\"");
    assert.match(wranglerExample, /REPLACE_WITH_YOUR_D1_DATABASE_ID/, "N01: Tracked template must use placeholder prod DB ID (zero secrets)");
    assert.match(wranglerExample, /REPLACE_WITH_STAGING_D1_DATABASE_ID/, "N01: Tracked template must use placeholder staging DB ID (zero secrets)");
    const gitignoreTxt = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
    assert.ok(gitignoreTxt.includes("workers/friesgo-api/wrangler.toml"), "N01: Real wrangler.toml must remain gitignored");

    // --- S08: Single-Transaction Atomic Idempotency Commit Across All 4 Write Endpoints ---
    let failNextBatchOnLastStmt = false;
    const faultDb = {
      raw: db.raw,
      prepare: (sql) => db.prepare(sql),
      async batch(stmts) {
        if (!failNextBatchOnLastStmt) return db.batch(stmts);
        failNextBatchOnLastStmt = false;
        db.raw.exec("BEGIN IMMEDIATE");
        try {
          for (let i = 0; i < stmts.length; i++) {
            if (i === stmts.length - 1) throw new Error("SIMULATED_IDEM_COMPLETE_FAILURE");
            await stmts[i].run();
          }
          db.raw.exec("COMMIT");
        } catch (err) {
          try { db.raw.exec("ROLLBACK"); } catch {}
          throw err;
        }
      },
    };
    const faultEnv = makeEnv(faultDb, { TURNSTILE_SECRET_KEY: "" });

    const s08Cases = [
      {
        name: "v3_acq_signals",
        url: "/api/v3/acq/signals",
        token: adminToken,
        orgId: "org_friesgo_main",
        idemKey: "idem_s08_atomic_signal_1",
        body: { source_platform: "facebook", acquisition_mode: "manual_discovery", demand_summary: "TEST_S08_ATOMIC_SIG_MARKER" },
        countSql: "SELECT COUNT(*) AS cnt FROM demand_signals WHERE demand_summary = 'TEST_S08_ATOMIC_SIG_MARKER'",
      },
      {
        name: "v3_deal_reg",
        url: "/api/v3/partner/deal-reg",
        token: partnerUser.token,
        orgId: "org_friesgo_main",
        idemKey: "idem_s08_atomic_dr_1",
        body: { reg_tier: "relationship_reg", company_name: "TEST_S08_ATOMIC_DR_CORP", country_en: "UAE" },
        countSql: "SELECT COUNT(*) AS cnt FROM deal_registrations WHERE company_name = 'TEST_S08_ATOMIC_DR_CORP'",
      },
      {
        name: "public_applications",
        url: "/api/public/applications",
        token: "",
        orgId: "",
        idemKey: "idem_s08_atomic_app_1",
        body: {
          app_type: "tool_trial",
          applicant_name: "TEST_S08_ATOMIC_APP_USER",
          contact_channel: "email",
          contact_value: "s08.app@example.test",
          privacyConsent: true,
        },
        countSql: "SELECT COUNT(*) AS cnt FROM applications WHERE applicant_name = 'TEST_S08_ATOMIC_APP_USER'",
      },
      {
        name: "public_rfq",
        url: "/api/public/rfq",
        token: "",
        orgId: "",
        idemKey: "idem_s08_atomic_rfq_1",
        body: {
          demandSummary: "TEST_S08_ATOMIC_RFQ_MARKER need steel valves",
          country_en: "UAE",
          contactChannel: "email",
          contactValue: "s08.rfq@example.test",
          privacyConsent: true,
        },
        countSql: "SELECT COUNT(*) AS cnt FROM demand_signals WHERE demand_summary LIKE 'TEST_S08_ATOMIC_RFQ_MARKER%'",
      },
    ];

    for (const tc of s08Cases) {
      failNextBatchOnLastStmt = true;
      let firstStatus = 500;
      try {
        const rFail = await callApi(worker, faultEnv, "POST", tc.url, {
          token: tc.token,
          orgId: tc.orgId,
          idemKey: tc.idemKey,
          body: tc.body,
        });
        firstStatus = rFail.status;
      } catch {
        firstStatus = 500;
      }
      assert.ok(firstStatus >= 500, `S08 (${tc.name}): Simulated batch failure must fail 5xx`);
      const cntAfterFail = Number(db.raw.prepare(tc.countSql).get().cnt);
      assert.equal(cntAfterFail, 0, `S08 (${tc.name}): Atomic batch rollback MUST leave 0 rows after mid-commit failure!`);

      const rRetry = await callApi(worker, faultEnv, "POST", tc.url, {
        token: tc.token,
        orgId: tc.orgId,
        idemKey: tc.idemKey,
        body: tc.body,
      });
      assert.equal(rRetry.status, 201, `S08 (${tc.name}): Retry with same idemKey must succeed 201`);
      const cntAfterRetry = Number(db.raw.prepare(tc.countSql).get().cnt);
      assert.equal(cntAfterRetry, 1, `S08 (${tc.name}): Retry must produce EXACTLY 1 row`);

      const rReplay = await callApi(worker, faultEnv, "POST", tc.url, {
        token: tc.token,
        orgId: tc.orgId,
        idemKey: tc.idemKey,
        body: tc.body,
      });
      assert.ok([200, 201].includes(rReplay.status), `S08 (${tc.name}): Replay must return 200 or cached 201 (got ${rReplay.status})`);
      assert.equal(rReplay.data.replayed, true, `S08 (${tc.name}): Replay must report replayed=true`);
      const cntAfterReplay = Number(db.raw.prepare(tc.countSql).get().cnt);
      assert.equal(cntAfterReplay, 1, `S08 (${tc.name}): Replay must keep row count at EXACTLY 1 (never 2!)`);
    }

    console.log("PASS BLOCK 6 (S01–S08): Legacy isolation, disabled membership fail-closed, partner signal auth, attachment visibility/auth, monotonic opt-out lock + audited reconsent, quote schema/cost-strip, V3 feature flag fail-closed & single-tx atomic idempotency verified");
  }

  // =========================================================================
  // BLOCK 7 (N01–N04): CI Gate, Multi-Currency Spend Isolation, Zero-Yield Tasks, Shared ANY & UTC+8 Date Window
  // =========================================================================
  {
    // --- N01: CI Quality Gate Static Proof ---
    const ciYml = fs.readFileSync(path.join(ROOT, ".github/workflows/ci-quality-gate.yml"), "utf8");
    assert.ok(ciYml.includes("tests/v3-slice1-verify.js"), "N01: CI must execute v3-slice1-verify.js");
    assert.ok(ciYml.includes("tests/phase2a-verify.js") && ciYml.includes("tests/phase2b-verify.js"), "N01: CI must execute phase2a & phase2b");
    assert.ok(ciYml.includes("tests/full-audit-suite.js"), "N01: CI must execute full-audit-suite.js");
    assert.ok(ciYml.includes("join.html") && ciYml.includes("rfq.html"), "N01: CI must package and verify join.html and rfq.html");
    assert.ok(ciYml.includes("_pages_dist"), "N01: CI must verify _pages_dist asset completeness");

    // --- N02: Multi-Currency Spend Isolation (USD 1.00 + JPY 200 -> NEVER 3.00!) ---
    const badNoCur = await callApi(worker, env, "POST", "/api/v3/acq/tasks", {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { platform: "linkedin", acquisition_mode: "owned_ad_form", title: "Missing currency", actual_spend_minor: 100 },
    });
    assert.equal(badNoCur.status, 400);
    assert.equal(badNoCur.data.code, "SPEND_CURRENCY_REQUIRED");

    const badCur = await callApi(worker, env, "POST", "/api/v3/acq/tasks", {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { platform: "linkedin", acquisition_mode: "owned_ad_form", title: "Invalid currency", actual_spend_minor: 100, spend_currency: "ZZZ" },
    });
    assert.equal(badCur.status, 400);

    const badFloatSpend = await callApi(worker, env, "POST", "/api/v3/acq/tasks", {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { platform: "linkedin", acquisition_mode: "owned_ad_form", title: "Float spend", actual_spend_minor: 1.5, spend_currency: "USD" },
    });
    assert.equal(badFloatSpend.status, 400);

    // 2 valid zero-yield tasks in Vietnam with USD 1.00 (100 minor) + JPY 200 (200 minor)
    const tUsd = await callApi(worker, env, "POST", "/api/v3/acq/tasks", {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: {
        platform: "linkedin",
        acquisition_mode: "owned_ad_form",
        title: "TEST N02/N03 Vietnam USD Boost (Zero Yield)",
        country_scope: "Vietnam",
        product_line: "valves",
        hours_logged_tenths: 10,
        actual_spend_minor: 100,
        spend_currency: "USD",
      },
    });
    assert.equal(tUsd.status, 201);
    const tJpy = await callApi(worker, env, "POST", "/api/v3/acq/tasks", {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: {
        platform: "linkedin",
        acquisition_mode: "owned_ad_form",
        title: "TEST N02/N03 Vietnam JPY Boost (Zero Yield)",
        country_scope: "Vietnam",
        product_line: "valves",
        hours_logged_tenths: 5,
        actual_spend_minor: 200,
        spend_currency: "JPY",
      },
    });
    assert.equal(tJpy.status, 201);

    // Another country task (Saudi Arabia) to verify N03 strict country filtering
    const tSaudi = await callApi(worker, env, "POST", "/api/v3/acq/tasks", {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: {
        platform: "instagram",
        acquisition_mode: "owned_ad_form",
        title: "TEST N03 Saudi Task Should Be Excluded From Vietnam Filter",
        country_scope: "Saudi Arabia",
        product_line: "cables",
        hours_logged_tenths: 25,
        actual_spend_minor: 5000,
        spend_currency: "USD",
      },
    });
    assert.equal(tSaudi.status, 201);

    const cmpVn = await callApi(worker, env, "GET", "/api/v3/acq/source-comparison?country=Vietnam", {
      token: adminToken,
      orgId: "org_friesgo_main",
    });
    assert.equal(cmpVn.status, 200);
    const liBoost = cmpVn.data.groups.find((g) => g.source_platform === "linkedin" && g.acquisition_mode === "owned_ad_form");
    assert.ok(liBoost, "N03: Zero-yield Vietnam task MUST appear in country=Vietnam source-comparison");
    assert.equal(liBoost.zero_yield_task, true);
    assert.equal(liBoost.checked_candidates, 0);
    assert.equal(liBoost.hours_logged_tenths, 15);
    assert.equal(liBoost.spend_status, "multi_currency_separate", "N02: Mixed USD + JPY must report multi_currency_separate");
    assert.equal(liBoost.actual_spend_minor, null, "N02: Mixed currencies must NEVER be summed into a single minor total");
    assert.equal(liBoost.spend_by_currency.USD.formatted, "USD 1.00");
    assert.equal(liBoost.spend_by_currency.JPY.formatted, "JPY 200");
    assert.equal(liBoost.spend_display, "JPY 200 + USD 1.00");

    const igSaudiInVn = cmpVn.data.groups.find((g) => g.source_platform === "instagram" && g.acquisition_mode === "owned_ad_form");
    assert.equal(igSaudiInVn, undefined, "N03: Saudi Arabia task MUST be excluded when filtering country=Vietnam");
    assert.ok(
      Array.isArray(cmpVn.data.sharedUnallocatedTasks) && cmpVn.data.sharedUnallocatedTasks.some((x) => x.platform === "facebook"),
      "N03: Shared ANY-country tasks must be transparently surfaced in sharedUnallocatedTasks rather than silently mixed into Vietnam"
    );

    // --- N04: Strict Half-Open UTC+8 Date Window ---
    const badRange1 = await callApi(worker, env, "GET", "/api/v3/acq/source-comparison?from=2026-11-30&to=2026-11-28", {
      token: adminToken,
      orgId: "org_friesgo_main",
    });
    assert.equal(badRange1.status, 400);
    assert.equal(badRange1.data.code, "INVALID_DATE_RANGE");

    const badRange2 = await callApi(worker, env, "GET", "/api/v3/acq/source-comparison?from=2026-99-99", {
      token: adminToken,
      orgId: "org_friesgo_main",
    });
    assert.equal(badRange2.status, 400);
    assert.equal(badRange2.data.code, "INVALID_DATE_RANGE");

    // Seed two dated signals on UTC+8 boundary for 2026-10-15:
    //   sigIn:  2026-10-15T04:00:00.000Z (= 2026-10-15 12:00 UTC+8 -> INCLUDED)
    //   sigOut: 2026-10-15T16:30:00.000Z (= 2026-10-16 00:30 UTC+8 -> EXCLUDED!)
    const sigIn = await callApi(worker, env, "POST", "/api/v3/acq/signals", {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { source_platform: "instagram", acquisition_mode: "owned_account_inquiry", country_en: "Peru", demand_summary: "TEST N04 Included UTC+8 same-day signal" },
    });
    const sigOut = await callApi(worker, env, "POST", "/api/v3/acq/signals", {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { source_platform: "instagram", acquisition_mode: "owned_account_inquiry", country_en: "Peru", demand_summary: "TEST N04 Excluded next-day UTC+8 signal" },
    });
    db.raw.prepare("UPDATE demand_signals SET discovered_at = '2026-10-15T04:00:00.000Z' WHERE id = ?").run(sigIn.data.signal.id);
    db.raw.prepare("UPDATE demand_signals SET discovered_at = '2026-10-15T16:30:00.000Z' WHERE id = ?").run(sigOut.data.signal.id);

    const cmpDay = await callApi(worker, env, "GET", "/api/v3/acq/source-comparison?from=2026-10-15&to=2026-10-15&country=Peru", {
      token: adminToken,
      orgId: "org_friesgo_main",
    });
    assert.equal(cmpDay.status, 200);
    assert.equal(cmpDay.data.observationWindow.tz_offset_minutes, 480);
    assert.equal(cmpDay.data.observationWindow.start_iso_utc, "2026-10-14T16:00:00.000Z");
    assert.equal(cmpDay.data.observationWindow.end_iso_utc, "2026-10-15T16:00:00.000Z");
    assert.equal(cmpDay.data.observationWindow.end_exclusive, true);
    const igDay = cmpDay.data.groups.find((g) => g.source_platform === "instagram" && g.acquisition_mode === "owned_account_inquiry");
    assert.ok(igDay, "N04: Same-day UTC+8 signal MUST be included");
    assert.equal(igDay.checked_candidates, 1, "N04: Half-open UTC+8 window must include 04:00Z (12:00 UTC+8) and exclude 16:30Z (00:30 next day UTC+8)");

    // --- N03 Period Ledger: Disjoint Windows, Title-Only Edit, Multi-Month Efforts, Historical Correction, Zero vs Unrecorded & Shared Cross-Product ---
    // N03-A (Exact Recheck Counterexample): Task created 2026-11-01 with 50h / USD 100, title edited 2026-11-28 -> MUST NOT double-count on Nov 28!
    const n03CounterTask = await callApi(worker, env, "POST", "/api/v3/acq/tasks", {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: {
        platform: "facebook",
        acquisition_mode: "manual_discovery",
        title: "TEST N03 Nov-1 Task (50h / USD 100)",
        country_scope: "Vietnam",
        product_keywords: "valves",
        hours_logged_tenths: 500,
        actual_spend_minor: 10000,
        spend_currency: "USD",
        occurred_at: "2026-11-01",
      },
    });
    assert.equal(n03CounterTask.status, 201);
    const n03CounterTaskId = n03CounterTask.data.task.id;

    // Metadata-only PATCH (title edited on 2026-11-28) -> updated_at moves to Nov 28, effort_entries_added MUST be 0!
    const titleOnlyPatch = await callApi(worker, env, "PATCH", `/api/v3/acq/tasks/${n03CounterTaskId}`, {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { title: "TEST N03 Title Edited On Nov 28 Only" },
    });
    assert.equal(titleOnlyPatch.status, 200);
    assert.equal(titleOnlyPatch.data.effort_entries_added, 0, "N03: Title-only edit must NOT write any effort ledger row");
    db.raw.prepare("UPDATE discovery_tasks SET updated_at = '2026-11-28T04:00:00.000Z' WHERE id = ?").run(n03CounterTaskId);

    const cmpNov1 = await callApi(worker, env, "GET", "/api/v3/acq/source-comparison?from=2026-11-01&to=2026-11-01&country=Vietnam&product_line=valves", {
      token: adminToken,
      orgId: "org_friesgo_main",
    });
    const cmpNov28 = await callApi(worker, env, "GET", "/api/v3/acq/source-comparison?from=2026-11-28&to=2026-11-28&country=Vietnam&product_line=valves", {
      token: adminToken,
      orgId: "org_friesgo_main",
    });
    assert.equal(cmpNov1.status, 200);
    assert.equal(cmpNov28.status, 200);
    const fbNov1 = cmpNov1.data.groups.find((g) => g.source_platform === "facebook" && g.acquisition_mode === "manual_discovery");
    const fbNov28 = cmpNov28.data.groups.find((g) => g.source_platform === "facebook" && g.acquisition_mode === "manual_discovery");
    assert.ok(fbNov1, "N03-A: Nov 1 window must include the 50h / USD 100 initial effort");
    assert.equal(fbNov1.hours_logged_tenths, 500);
    assert.equal(fbNov1.spend_display, "USD 100.00");
    assert.equal(fbNov28, undefined, "N03-A: Nov 28 window must NOT double-count Nov 1 effort after title-only update!");

    // N03-B: Multi-month incremental entries + multi-currency + historical adjustment + over-adjustment rejection + 3-window exact reconciliation!
    const n03MultiTask = await callApi(worker, env, "POST", "/api/v3/acq/tasks", {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: {
        platform: "instagram",
        acquisition_mode: "manual_discovery",
        title: "TEST N03 Thailand PE Pipes Multi-Month Ledger",
        country_scope: "Thailand",
        product_keywords: "pe_pipes",
        hours_logged_tenths: 100, // 10.0h on 2026-10-20
        actual_spend_minor: 5000, // USD 50.00
        spend_currency: "USD",
        occurred_at: "2026-10-20",
      },
    });
    assert.equal(n03MultiTask.status, 201);
    const multiTaskId = n03MultiTask.data.task.id;

    // Incremental log #1 on 2026-11-05 (+15.0h, +USD 30.00)
    assert.equal(
      (await callApi(worker, env, "POST", `/api/v3/acq/tasks/${multiTaskId}/efforts`, {
        token: adminToken,
        orgId: "org_friesgo_main",
        body: { occurred_at: "2026-11-05", hours_delta_tenths: 150, spend_delta_minor: 3000, spend_currency: "USD", entry_type: "log", note: "Nov 5 outreach batch" },
      })).status,
      201
    );
    // Incremental log #2 on 2026-11-28 (+5.0h, +JPY 200)
    assert.equal(
      (await callApi(worker, env, "POST", `/api/v3/acq/tasks/${multiTaskId}/efforts`, {
        token: adminToken,
        orgId: "org_friesgo_main",
        body: { occurred_at: "2026-11-28", hours_delta_tenths: 50, spend_delta_minor: 200, spend_currency: "JPY", entry_type: "log", note: "Nov 28 JPY promo" },
      })).status,
      201
    );
    // Historical correction on 2026-11-05 (-2.0h, -USD 10.00)
    assert.equal(
      (await callApi(worker, env, "POST", `/api/v3/acq/tasks/${multiTaskId}/efforts`, {
        token: adminToken,
        orgId: "org_friesgo_main",
        body: { occurred_at: "2026-11-05", hours_delta_tenths: -20, spend_delta_minor: -1000, spend_currency: "USD", entry_type: "adjustment", note: "Correct Nov 5 over-logged hours/ad credit" },
      })).status,
      201
    );
    // Negative log without entry_type='adjustment' -> 400; over-adjustment driving cumulative < 0 -> 400 NEGATIVE_CUMULATIVE_NOT_ALLOWED
    assert.equal(
      (await callApi(worker, env, "POST", `/api/v3/acq/tasks/${multiTaskId}/efforts`, {
        token: adminToken,
        orgId: "org_friesgo_main",
        body: { occurred_at: "2026-11-05", hours_delta_tenths: -10, entry_type: "log" },
      })).status,
      400
    );
    const overAdj = await callApi(worker, env, "POST", `/api/v3/acq/tasks/${multiTaskId}/efforts`, {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { occurred_at: "2026-11-05", hours_delta_tenths: -9999, entry_type: "adjustment" },
    });
    assert.equal(overAdj.status, 400);
    assert.equal(overAdj.data.code, "NEGATIVE_CUMULATIVE_NOT_ALLOWED");

    // Reconcile ledger summary vs 3 disjoint windows: Oct (10h / USD 50), Nov 1-27 (13h / USD 20), Nov 28 (5h / JPY 200) -> SUM = 28h / USD 70 + JPY 200!
    const effLedger = await callApi(worker, env, "GET", `/api/v3/acq/tasks/${multiTaskId}/efforts`, {
      token: adminToken,
      orgId: "org_friesgo_main",
    });
    assert.equal(effLedger.status, 200);
    assert.equal(effLedger.data.efforts.length, 4);
    assert.equal(effLedger.data.reconciled.hours_logged_tenths, 280);
    assert.equal(effLedger.data.reconciled.spend_display, "JPY 200 + USD 70.00");

    const cmpThW1 = await callApi(worker, env, "GET", "/api/v3/acq/source-comparison?from=2026-10-01&to=2026-10-31&country=Thailand", { token: adminToken, orgId: "org_friesgo_main" });
    const cmpThW2 = await callApi(worker, env, "GET", "/api/v3/acq/source-comparison?from=2026-11-01&to=2026-11-27&country=Thailand", { token: adminToken, orgId: "org_friesgo_main" });
    const cmpThW3 = await callApi(worker, env, "GET", "/api/v3/acq/source-comparison?from=2026-11-28&to=2026-11-28&country=Thailand", { token: adminToken, orgId: "org_friesgo_main" });
    const gW1 = cmpThW1.data.groups.find((g) => g.source_platform === "instagram" && g.acquisition_mode === "manual_discovery");
    const gW2 = cmpThW2.data.groups.find((g) => g.source_platform === "instagram" && g.acquisition_mode === "manual_discovery");
    const gW3 = cmpThW3.data.groups.find((g) => g.source_platform === "instagram" && g.acquisition_mode === "manual_discovery");
    assert.equal(gW1.hours_logged_tenths, 100);
    assert.equal(gW1.spend_display, "USD 50.00");
    assert.equal(gW2.hours_logged_tenths, 130);
    assert.equal(gW2.spend_display, "USD 20.00");
    assert.equal(gW2.cumulative_reference.hours_logged_tenths, 280);
    assert.equal(gW2.cumulative_reference.spend_display, "JPY 200 + USD 70.00");
    assert.equal(gW3.hours_logged_tenths, 50);
    assert.equal(gW3.spend_display, "JPY 200");
    assert.equal(
      gW1.hours_logged_tenths + gW2.hours_logged_tenths + gW3.hours_logged_tenths,
      effLedger.data.reconciled.hours_logged_tenths,
      "N03-B: Sum of disjoint period windows MUST strictly reconcile to cumulative ledger hours"
    );
    assert.equal(
      gW1.spend_by_currency.USD.minor + gW2.spend_by_currency.USD.minor,
      effLedger.data.reconciled.spend_by_currency.USD.minor,
      "N03-B: Sum of disjoint period USD spend MUST strictly reconcile to cumulative USD ledger"
    );
    assert.equal(
      gW3.spend_by_currency.JPY.minor,
      effLedger.data.reconciled.spend_by_currency.JPY.minor,
      "N03-B: Disjoint period JPY spend MUST strictly reconcile to cumulative JPY ledger"
    );

    // N03-C: Explicit zero spend (USD 0.00) vs unrecorded spend (null -> unknown_not_recorded)
    await callApi(worker, env, "POST", "/api/v3/acq/tasks", {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { platform: "facebook", acquisition_mode: "manual_discovery", title: "TEST N03 Unrecorded Spend Task", country_scope: "Chile", hours_logged_tenths: 0, actual_spend_minor: null, occurred_at: "2026-09-10" },
    });
    await callApi(worker, env, "POST", "/api/v3/acq/tasks", {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: { platform: "facebook", acquisition_mode: "manual_discovery", title: "TEST N03 Explicit Zero Spend Task", country_scope: "Colombia", hours_logged_tenths: 0, actual_spend_minor: 0, spend_currency: "USD", occurred_at: "2026-09-10" },
    });
    const cmpChile = await callApi(worker, env, "GET", "/api/v3/acq/source-comparison?from=2026-09-10&to=2026-09-10&country=Chile", { token: adminToken, orgId: "org_friesgo_main" });
    const cmpCol = await callApi(worker, env, "GET", "/api/v3/acq/source-comparison?from=2026-09-10&to=2026-09-10&country=Colombia", { token: adminToken, orgId: "org_friesgo_main" });
    assert.equal(cmpChile.data.groups[0].hours_logged_tenths, 0);
    assert.equal(cmpChile.data.groups[0].spend_status, "unknown_not_recorded");
    assert.equal(cmpChile.data.groups[0].spend_display, "未记录");
    assert.equal(cmpCol.data.groups[0].hours_logged_tenths, 0);
    assert.equal(cmpCol.data.groups[0].spend_status, "recorded");
    assert.equal(cmpCol.data.groups[0].actual_spend_minor, 0);
    assert.equal(cmpCol.data.groups[0].spend_display, "USD 0.00");

    // N03-D: Cross-product generic task (empty product_keywords) remains shared_unallocated AND strictly period-scoped!
    await callApi(worker, env, "POST", "/api/v3/acq/tasks", {
      token: adminToken,
      orgId: "org_friesgo_main",
      body: {
        platform: "linkedin",
        acquisition_mode: "manual_discovery",
        title: "TEST N03 Thailand Generic All-Products Outreach",
        country_scope: "Thailand",
        product_keywords: "",
        hours_logged_tenths: 40,
        occurred_at: "2026-10-20",
      },
    });
    const cmpThProdOct = await callApi(worker, env, "GET", "/api/v3/acq/source-comparison?from=2026-10-01&to=2026-10-31&country=Thailand&product_line=pe_pipes", { token: adminToken, orgId: "org_friesgo_main" });
    const cmpThProdNov = await callApi(worker, env, "GET", "/api/v3/acq/source-comparison?from=2026-11-01&to=2026-11-30&country=Thailand&product_line=pe_pipes", { token: adminToken, orgId: "org_friesgo_main" });
    const sharedProdOct = cmpThProdOct.data.sharedUnallocatedTasks.find((x) => x.title.includes("Generic All-Products"));
    const sharedProdNov = cmpThProdNov.data.sharedUnallocatedTasks.find((x) => x.title.includes("Generic All-Products"));
    assert.ok(sharedProdOct, "N03-D: Generic cross-product task must appear in sharedUnallocatedTasks in Oct");
    assert.equal(sharedProdOct.shared_reason, "shared_product_any");
    assert.equal(sharedProdOct.period_hours_tenths, 40);
    assert.equal(sharedProdNov, undefined, "N03-D: Oct shared task must NOT leak into Nov window");

    // --- I01: Barrier-Synchronized Concurrent Effort & PATCH CAS Consistency Matrix ---
    {
      let barrierExpected = 0;
      let barrierWaiters = [];
      let failNextBatchLastStmt = false;
      let txChain = Promise.resolve();

      const setReadBarrier = (n) => {
        barrierExpected = n;
        barrierWaiters = [];
      };
      const maybeHitBarrier = async (sql) => {
        if (barrierExpected > 0 && /FROM\s+discovery_task_efforts\s+WHERE/i.test(sql)) {
          await new Promise((resolve) => {
            barrierWaiters.push(resolve);
            if (barrierWaiters.length >= barrierExpected) {
              barrierExpected = 0;
              const ws = barrierWaiters;
              barrierWaiters = [];
              setImmediate(() => ws.forEach((fn) => fn()));
            }
          });
        }
      };
      const wrapI01Stmt = (sql, params = []) => ({
        bind: (...args) => wrapI01Stmt(sql, args),
        async first() {
          const r = db.raw.prepare(sql).get(...params);
          return r === undefined ? null : { ...r };
        },
        async all() {
          await maybeHitBarrier(sql);
          const rows = db.raw.prepare(sql).all(...params);
          return { results: rows.map((r) => ({ ...r })), success: true };
        },
        async run() {
          const info = db.raw.prepare(sql).run(...params);
          return { success: true, meta: { changes: Number(info.changes || 0), last_row_id: Number(info.lastInsertRowid || 0) } };
        },
      });
      const i01Db = {
        raw: db.raw,
        prepare: (sql) => wrapI01Stmt(sql, []),
        batch(stmts) {
          const runTx = async () => {
            const failNow = failNextBatchLastStmt;
            failNextBatchLastStmt = false;
            db.raw.exec("BEGIN IMMEDIATE");
            try {
              const out = [];
              for (let i = 0; i < stmts.length; i++) {
                if (failNow && i === stmts.length - 1) throw new Error("SIMULATED_I01_BATCH_ABORT");
                out.push(await stmts[i].run());
              }
              db.raw.exec("COMMIT");
              return out;
            } catch (err) {
              try { db.raw.exec("ROLLBACK"); } catch {}
              throw err;
            }
          };
          const p = txChain.then(runTx, runTx);
          txChain = p.catch(() => {});
          return p;
        },
      };
      const i01Env = makeEnv(i01Db);
      const inspectTaskTotals = (tid) => {
        const tRow = db.raw.prepare("SELECT title, hours_logged_tenths, actual_spend_minor, spend_currency, effort_version FROM discovery_tasks WHERE id = ?").get(tid);
        const lHrs = Number(db.raw.prepare("SELECT COALESCE(SUM(hours_delta_tenths), 0) AS s FROM discovery_task_efforts WHERE task_id = ?").get(tid).s);
        const lSpendRows = db.raw.prepare("SELECT spend_currency, COALESCE(SUM(spend_delta_minor), 0) AS s FROM discovery_task_efforts WHERE task_id = ? AND spend_delta_minor IS NOT NULL GROUP BY spend_currency").all(tid);
        const lSpend = Object.fromEntries(lSpendRows.map((r) => [r.spend_currency, Number(r.s)]));
        return { task: tRow, ledgerHours: lHrs, ledgerSpend: lSpend };
      };

      // I01-1: Concurrent same-currency additions (+10h / +10 USD cents twice from 100) -> BOTH 201, ledger===summary===120!
      const tSame = (await callApi(worker, i01Env, "POST", "/api/v3/acq/tasks", {
        token: adminToken, orgId: "org_friesgo_main",
        body: { platform: "facebook", acquisition_mode: "manual_discovery", title: "TEST I01 Same-Cur Concurrent", country_scope: "Malaysia", hours_logged_tenths: 100, actual_spend_minor: 100, spend_currency: "USD", occurred_at: "2026-08-01" },
      })).data.task.id;
      setReadBarrier(2);
      const [s1, s2] = await Promise.all([
        callApi(worker, i01Env, "POST", `/api/v3/acq/tasks/${tSame}/efforts`, { token: adminToken, orgId: "org_friesgo_main", body: { occurred_at: "2026-08-02", hours_delta_tenths: 10, spend_delta_minor: 10, spend_currency: "USD", entry_type: "log" } }),
        callApi(worker, i01Env, "POST", `/api/v3/acq/tasks/${tSame}/efforts`, { token: adminToken, orgId: "org_friesgo_main", body: { occurred_at: "2026-08-03", hours_delta_tenths: 10, spend_delta_minor: 10, spend_currency: "USD", entry_type: "log" } }),
      ]);
      assert.deepEqual([s1.status, s2.status], [201, 201], "I01-1: Concurrent additive logs must both succeed via CAS retry");
      const stSame = inspectTaskTotals(tSame);
      assert.equal(stSame.ledgerHours, 120);
      assert.equal(stSame.task.hours_logged_tenths, 120);
      assert.equal(stSame.ledgerSpend.USD, 120);
      assert.equal(stSame.task.actual_spend_minor, 120);
      assert.equal(stSame.task.effort_version, 3);

      // I01-2: Concurrent mixed-currency additions (+10h USD 100 & +5h JPY 200 from 100h USD 100) -> BOTH 201, 115h & MULTI (JPY 200 + USD 200)
      const tCross = (await callApi(worker, i01Env, "POST", "/api/v3/acq/tasks", {
        token: adminToken, orgId: "org_friesgo_main",
        body: { platform: "instagram", acquisition_mode: "manual_discovery", title: "TEST I01 Cross-Cur Concurrent", country_scope: "Malaysia", hours_logged_tenths: 100, actual_spend_minor: 100, spend_currency: "USD", occurred_at: "2026-08-01" },
      })).data.task.id;
      setReadBarrier(2);
      const [m1, m2] = await Promise.all([
        callApi(worker, i01Env, "POST", `/api/v3/acq/tasks/${tCross}/efforts`, { token: adminToken, orgId: "org_friesgo_main", body: { occurred_at: "2026-08-02", hours_delta_tenths: 10, spend_delta_minor: 100, spend_currency: "USD", entry_type: "log" } }),
        callApi(worker, i01Env, "POST", `/api/v3/acq/tasks/${tCross}/efforts`, { token: adminToken, orgId: "org_friesgo_main", body: { occurred_at: "2026-08-03", hours_delta_tenths: 5, spend_delta_minor: 200, spend_currency: "JPY", entry_type: "log" } }),
      ]);
      assert.deepEqual([m1.status, m2.status], [201, 201]);
      const stCross = inspectTaskTotals(tCross);
      assert.equal(stCross.ledgerHours, 115);
      assert.equal(stCross.task.hours_logged_tenths, 115);
      assert.equal(stCross.ledgerSpend.USD, 200);
      assert.equal(stCross.ledgerSpend.JPY, 200);
      assert.equal(stCross.task.spend_currency, "MULTI");
      assert.equal(stCross.task.actual_spend_minor, null);

      // I01-3: Concurrent over-adjustments (-80h / -80 USD twice from 100) -> [201, 400], ledger===summary===20 (NEVER negative!)
      const tAdj = (await callApi(worker, i01Env, "POST", "/api/v3/acq/tasks", {
        token: adminToken, orgId: "org_friesgo_main",
        body: { platform: "linkedin", acquisition_mode: "manual_discovery", title: "TEST I01 Over-Adjust Race", country_scope: "Indonesia", hours_logged_tenths: 100, actual_spend_minor: 100, spend_currency: "USD", occurred_at: "2026-08-01" },
      })).data.task.id;
      setReadBarrier(2);
      const [a1, a2] = await Promise.all([
        callApi(worker, i01Env, "POST", `/api/v3/acq/tasks/${tAdj}/efforts`, { token: adminToken, orgId: "org_friesgo_main", body: { occurred_at: "2026-08-01", hours_delta_tenths: -80, spend_delta_minor: -80, spend_currency: "USD", entry_type: "adjustment" } }),
        callApi(worker, i01Env, "POST", `/api/v3/acq/tasks/${tAdj}/efforts`, { token: adminToken, orgId: "org_friesgo_main", body: { occurred_at: "2026-08-01", hours_delta_tenths: -80, spend_delta_minor: -80, spend_currency: "USD", entry_type: "adjustment" } }),
      ]);
      assert.deepEqual([a1.status, a2.status].sort(), [201, 400], "I01-3: Concurrent over-adjustments must allow at most 1 and reject the second 400");
      const rejectedAdj = a1.status === 400 ? a1 : a2;
      assert.equal(rejectedAdj.data.code, "NEGATIVE_CUMULATIVE_NOT_ALLOWED");
      const stAdj = inspectTaskTotals(tAdj);
      assert.equal(stAdj.ledgerHours, 20);
      assert.equal(stAdj.task.hours_logged_tenths, 20);
      assert.equal(stAdj.ledgerSpend.USD, 20);
      assert.equal(stAdj.task.actual_spend_minor, 20);

      // I01-4: Concurrent POST /efforts (+10h) vs absolute PATCH (hours_logged_tenths: 150) -> stale PATCH gets 409 TASK_EFFORT_CONFLICT, retry succeeds & reconciles!
      const tPatchRace = (await callApi(worker, i01Env, "POST", "/api/v3/acq/tasks", {
        token: adminToken, orgId: "org_friesgo_main",
        body: { platform: "facebook", acquisition_mode: "manual_discovery", title: "TEST I01 Effort vs Absolute PATCH", country_scope: "Indonesia", hours_logged_tenths: 100, actual_spend_minor: 100, spend_currency: "USD", occurred_at: "2026-08-01" },
      })).data.task.id;
      setReadBarrier(2);
      const [pEff, pAbs] = await Promise.all([
        callApi(worker, i01Env, "POST", `/api/v3/acq/tasks/${tPatchRace}/efforts`, { token: adminToken, orgId: "org_friesgo_main", body: { occurred_at: "2026-08-02", hours_delta_tenths: 10, entry_type: "log" } }),
        callApi(worker, i01Env, "PATCH", `/api/v3/acq/tasks/${tPatchRace}`, { token: adminToken, orgId: "org_friesgo_main", body: { hours_logged_tenths: 150, occurred_at: "2026-08-03" } }),
      ]);
      assert.equal(pEff.status, 201);
      assert.equal(pAbs.status, 409, "I01-4: Stale absolute PATCH must return 409 TASK_EFFORT_CONFLICT instead of clobbering concurrent effort");
      assert.equal(pAbs.data.code, "TASK_EFFORT_CONFLICT");
      assert.equal(pAbs.data.current_version, 2);
      const stBeforeRetry = inspectTaskTotals(tPatchRace);
      assert.equal(stBeforeRetry.ledgerHours, 110);
      assert.equal(stBeforeRetry.task.hours_logged_tenths, 110);
      // Retry PATCH with fresh expected_version=2 -> succeeds 200 and reconciles to 150!
      const pRetry = await callApi(worker, i01Env, "PATCH", `/api/v3/acq/tasks/${tPatchRace}`, {
        token: adminToken, orgId: "org_friesgo_main",
        body: { hours_logged_tenths: 150, expected_version: pAbs.data.current_version, occurred_at: "2026-08-03" },
      });
      assert.equal(pRetry.status, 200);
      assert.equal(pRetry.data.effort_version, 3);
      const stAfterRetry = inspectTaskTotals(tPatchRace);
      assert.equal(stAfterRetry.ledgerHours, 150);
      assert.equal(stAfterRetry.task.hours_logged_tenths, 150);

      // I01-5: Explicit expected_version conflict + retry + concurrent relative add_hours_tenths + metadata-only PATCH
      const tOpt = (await callApi(worker, i01Env, "POST", "/api/v3/acq/tasks", {
        token: adminToken, orgId: "org_friesgo_main",
        body: { platform: "instagram", acquisition_mode: "manual_discovery", title: "TEST I01 Optimistic Lock & Metadata", country_scope: "Indonesia", hours_logged_tenths: 100, occurred_at: "2026-08-01" },
      })).data.task.id;
      setReadBarrier(2);
      const [o1, o2] = await Promise.all([
        callApi(worker, i01Env, "POST", `/api/v3/acq/tasks/${tOpt}/efforts`, { token: adminToken, orgId: "org_friesgo_main", body: { expected_version: 1, occurred_at: "2026-08-02", hours_delta_tenths: 15, entry_type: "log" } }),
        callApi(worker, i01Env, "POST", `/api/v3/acq/tasks/${tOpt}/efforts`, { token: adminToken, orgId: "org_friesgo_main", body: { expected_version: 1, occurred_at: "2026-08-02", hours_delta_tenths: 25, entry_type: "log" } }),
      ]);
      assert.deepEqual([o1.status, o2.status].sort(), [201, 409]);
      const oConflict = o1.status === 409 ? o1 : o2;
      const oWinDelta = o1.status === 201 ? 15 : 25;
      const oRetryDelta = o1.status === 201 ? 25 : 15;
      const oRetry = await callApi(worker, i01Env, "POST", `/api/v3/acq/tasks/${tOpt}/efforts`, {
        token: adminToken, orgId: "org_friesgo_main",
        body: { expected_version: oConflict.data.current_version, occurred_at: "2026-08-02", hours_delta_tenths: oRetryDelta, entry_type: "log" },
      });
      assert.equal(oRetry.status, 201);
      assert.equal(inspectTaskTotals(tOpt).ledgerHours, 100 + oWinDelta + oRetryDelta);

      // Concurrent relative PATCH (add_hours_tenths) + POST /efforts + metadata-only PATCH (title)
      setReadBarrier(2);
      const [relP, relE, metaP] = await Promise.all([
        callApi(worker, i01Env, "PATCH", `/api/v3/acq/tasks/${tOpt}`, { token: adminToken, orgId: "org_friesgo_main", body: { add_hours_tenths: 10, occurred_at: "2026-08-03" } }),
        callApi(worker, i01Env, "POST", `/api/v3/acq/tasks/${tOpt}/efforts`, { token: adminToken, orgId: "org_friesgo_main", body: { occurred_at: "2026-08-03", hours_delta_tenths: 20, entry_type: "log" } }),
        callApi(worker, i01Env, "PATCH", `/api/v3/acq/tasks/${tOpt}`, { token: adminToken, orgId: "org_friesgo_main", body: { title: "TEST I01 Renamed Concurrently" } }),
      ]);
      assert.equal(relP.status, 200);
      assert.equal(relE.status, 201);
      assert.equal(metaP.status, 200);
      const stRel = inspectTaskTotals(tOpt);
      assert.equal(stRel.ledgerHours, 170);
      assert.equal(stRel.task.hours_logged_tenths, 170);
      assert.equal(stRel.task.title, "TEST I01 Renamed Concurrently");

      // I01-6: Different tasks concurrent (zero cross-task conflict) + Mid-batch failure rollback (zero partial row/summary)
      const [tDiff1, tDiff2] = [
        (await callApi(worker, i01Env, "POST", "/api/v3/acq/tasks", { token: adminToken, orgId: "org_friesgo_main", body: { platform: "facebook", acquisition_mode: "manual_discovery", title: "TEST I01 Diff Task 1", country_scope: "Oman", hours_logged_tenths: 20, occurred_at: "2026-08-01" } })).data.task.id,
        (await callApi(worker, i01Env, "POST", "/api/v3/acq/tasks", { token: adminToken, orgId: "org_friesgo_main", body: { platform: "facebook", acquisition_mode: "manual_discovery", title: "TEST I01 Diff Task 2", country_scope: "Oman", hours_logged_tenths: 30, occurred_at: "2026-08-01" } })).data.task.id,
      ];
      setReadBarrier(2);
      const [d1, d2] = await Promise.all([
        callApi(worker, i01Env, "POST", `/api/v3/acq/tasks/${tDiff1}/efforts`, { token: adminToken, orgId: "org_friesgo_main", body: { occurred_at: "2026-08-02", hours_delta_tenths: 5, entry_type: "log" } }),
        callApi(worker, i01Env, "POST", `/api/v3/acq/tasks/${tDiff2}/efforts`, { token: adminToken, orgId: "org_friesgo_main", body: { occurred_at: "2026-08-02", hours_delta_tenths: 7, entry_type: "log" } }),
      ]);
      assert.deepEqual([d1.status, d2.status], [201, 201]);
      assert.equal(inspectTaskTotals(tDiff1).ledgerHours, 25);
      assert.equal(inspectTaskTotals(tDiff2).ledgerHours, 37);

      // Mid-batch failure on tDiff1 -> full rollback (hours stay 25, version stays 2, 0 orphan ledger rows)
      const verBeforeFail = inspectTaskTotals(tDiff1).task.effort_version;
      const cntBeforeFail = Number(db.raw.prepare("SELECT COUNT(*) AS c FROM discovery_task_efforts WHERE task_id = ?").get(tDiff1).c);
      failNextBatchLastStmt = true;
      let abortStatus = 500;
      try {
        abortStatus = (await callApi(worker, i01Env, "POST", `/api/v3/acq/tasks/${tDiff1}/efforts`, { token: adminToken, orgId: "org_friesgo_main", body: { occurred_at: "2026-08-04", hours_delta_tenths: 99, entry_type: "log" } })).status;
      } catch {
        abortStatus = 500;
      }
      assert.ok(abortStatus >= 500);
      const stAfterAbort = inspectTaskTotals(tDiff1);
      assert.equal(stAfterAbort.ledgerHours, 25);
      assert.equal(stAfterAbort.task.hours_logged_tenths, 25);
      assert.equal(stAfterAbort.task.effort_version, verBeforeFail);
      assert.equal(Number(db.raw.prepare("SELECT COUNT(*) AS c FROM discovery_task_efforts WHERE task_id = ?").get(tDiff1).c), cntBeforeFail);

      // Verify period source-comparison API reconciles Malaysia concurrent tasks (Aug 1-3): FB 12.0h / USD 1.20 & IG 11.5h / JPY 200 + USD 2.00
      const cmpMy = await callApi(worker, i01Env, "GET", "/api/v3/acq/source-comparison?from=2026-08-01&to=2026-08-03&country=Malaysia", { token: adminToken, orgId: "org_friesgo_main" });
      assert.equal(cmpMy.status, 200);
      const myFb = cmpMy.data.groups.find((g) => g.source_platform === "facebook" && g.acquisition_mode === "manual_discovery");
      const myIg = cmpMy.data.groups.find((g) => g.source_platform === "instagram" && g.acquisition_mode === "manual_discovery");
      assert.equal(myFb.hours_logged_tenths, 120);
      assert.equal(myFb.spend_display, "USD 1.20");
      assert.equal(myIg.hours_logged_tenths, 115);
      assert.equal(myIg.spend_display, "JPY 200 + USD 2.00");
    }

    // --- N08 API Contract Check: Full HTTPS deepLinkUrl inside wechatSafeCard ---
    const todosApi = await callApi(worker, env, "GET", "/api/v3/dispatch/my-todos?scope=all", {
      token: adminToken,
      orgId: "org_friesgo_main",
    });
    assert.equal(todosApi.status, 200);
    const targetTodo = todosApi.data.todos.find((t) => t.id === validDeepLinkTodoId);
    assert.ok(targetTodo, "N08: Target todo must exist in my-todos");
    assert.ok(
      /^https:\/\/.+index\.html\?v3_org=org_friesgo_main&v3_todo=.+#v3-todo=/.test(targetTodo.deepLinkUrl),
      `N08: deepLinkUrl must be a full clickable HTTPS URL with org & todo query/hash (got ${targetTodo.deepLinkUrl})`
    );
    assert.ok(
      targetTodo.wechatSafeCard.includes(targetTodo.deepLinkUrl),
      "N08: wechatSafeCard must embed the full clickable deepLinkUrl"
    );

    console.log("PASS BLOCK 7 (N01/N02/N03-PeriodLedger/I01-CAS/N04/N08-API): CI gate, USD+JPY multi-currency isolation, period occurred_at ledger, barrier-synchronized I01 CAS concurrency/conflict/retry/rollback, UTC+8 half-open date window & HTTPS WeChat deep-link verified");
  }

  // =========================================================================
  // BLOCK 8 (Real Headless Chrome Desktop + 360px Mobile): N06, N07, N08, N09, N10, N02-UI + REV01/REV10/ACQ04
  // =========================================================================
  let delayNextCompaniesMs = 0;
  let dropNextPublicAppResponseAfterCommit = false;
  const receivedPublicAppIdemKeys = [];
  let apiHitsDuringLocalGuardTest = 0;

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, "http://127.0.0.1");
    if (reqUrl.pathname.startsWith("/api/")) {
      apiHitsDuringLocalGuardTest += 1;
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const rawBody = Buffer.concat(chunks);
      if (reqUrl.pathname === "/api/v3/companies" && delayNextCompaniesMs > 0) {
        const d = delayNextCompaniesMs;
        delayNextCompaniesMs = 0;
        await sleep(d);
      }
      if (reqUrl.pathname === "/api/public/applications" && req.method === "POST") {
        receivedPublicAppIdemKeys.push(String(req.headers["x-idempotency-key"] || ""));
      }
      const wReq = new Request(`http://127.0.0.1${reqUrl.pathname}${reqUrl.search}`, {
        method: req.method,
        headers: req.headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : rawBody,
      });
      const wResp = await worker.fetch(wReq, env);
      if (reqUrl.pathname === "/api/public/applications" && req.method === "POST" && dropNextPublicAppResponseAfterCommit) {
        dropNextPublicAppResponseAfterCommit = false;
        // Simulate truncated/lost network response AFTER Worker already committed row to D1!
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "4096", Connection: "close" });
        res.flushHeaders();
        res.write('{"ok":true', () => {
          setTimeout(() => {
            if (req.socket) req.socket.destroy();
            else res.destroy();
          }, 20);
        });
        return;
      }
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

  // 8.1 N09 Localhost Guard + Client Validation BEFORE any ?api= or localStorage override!
  const chrome = await launchChromePage(`${baseUrl}/join.html`);
  try {
    apiHitsDuringLocalGuardTest = 0;
    const joinLocalGuard = await chrome.evalJs(`(async () => {
      const dbg0 = window.__FG_JOIN_DEBUG__();
      const bannerVisible = !document.getElementById("localApiGuardBanner").hidden;
      // Submit empty form -> client validation must focus #appName with aria-invalid="true" & show alert
      document.getElementById("btnSubmitJoin").click();
      await new Promise((r) => setTimeout(r, 120));
      const emptyActiveId = document.activeElement ? document.activeElement.id : "";
      const emptyAriaInvalid = document.getElementById("appName").getAttribute("aria-invalid");
      const emptyErrVisible = !document.getElementById("joinErrorBox").hidden;

      // Fill required fields and click submit WITHOUT ?api= -> local guard MUST block fallback to production!
      document.getElementById("appName").value = "Local Preview Should Not Hit Prod";
      document.getElementById("contactValue").value = "local_guard_test";
      document.getElementById("privacyConsent").checked = true;
      document.getElementById("btnSubmitJoin").click();
      await new Promise((r) => setTimeout(r, 150));
      const blockedErrTxt = document.getElementById("joinErrorBox").innerText;
      const blockedErrVisible = !document.getElementById("joinErrorBox").hidden;
      sessionStorage.clear();
      return { dbg0, bannerVisible, emptyActiveId, emptyAriaInvalid, emptyErrVisible, blockedErrVisible, blockedErrTxt };
    })()`);
    assert.equal(joinLocalGuard.dbg0.apiTarget.ok, false, "N09: join.html on localhost without ?api= must NOT default to production API");
    assert.equal(joinLocalGuard.dbg0.apiTarget.blockedLocalProd, true);
    assert.equal(joinLocalGuard.dbg0.apiTarget.url, "");
    assert.equal(joinLocalGuard.bannerVisible, true, "N09: Local preview guard banner must be visible");
    assert.equal(joinLocalGuard.emptyActiveId, "appName", "N09: Empty submit must focus first invalid input #appName");
    assert.equal(joinLocalGuard.emptyAriaInvalid, "true");
    assert.equal(joinLocalGuard.emptyErrVisible, true);
    assert.equal(joinLocalGuard.blockedErrVisible, true);
    assert.equal(apiHitsDuringLocalGuardTest, 0, "N09: Zero API fetches allowed during client validation & local-guard block");

    // N09 on rfq.html without ?api=
    await chrome.navigate(`${baseUrl}/rfq.html`);
    apiHitsDuringLocalGuardTest = 0;
    const rfqLocalGuard = await chrome.evalJs(`(async () => {
      const dbg0 = window.__FG_RFQ_DEBUG__();
      const bannerVisible = !document.getElementById("localApiGuardBanner").hidden;
      document.getElementById("btnSubmitRfq").click();
      await new Promise((r) => setTimeout(r, 120));
      const emptyActiveId = document.activeElement ? document.activeElement.id : "";
      const emptyAriaInvalid = document.getElementById("rfqDemand").getAttribute("aria-invalid");
      document.getElementById("rfqDemand").value = "Local preview RFQ should not hit prod";
      document.getElementById("rfqCountry").value = "UAE";
      document.getElementById("rfqContactVal").value = "local@example.test";
      document.getElementById("rfqPrivacyConsent").checked = true;
      document.getElementById("btnSubmitRfq").click();
      await new Promise((r) => setTimeout(r, 150));
      const blockedErrVisible = !document.getElementById("rfqErrorBox").hidden;
      sessionStorage.clear();
      return { dbg0, bannerVisible, emptyActiveId, emptyAriaInvalid, blockedErrVisible };
    })()`);
    assert.equal(rfqLocalGuard.dbg0.apiTarget.ok, false, "N09: rfq.html on localhost without ?api= must NOT default to production API");
    assert.equal(rfqLocalGuard.dbg0.apiTarget.blockedLocalProd, true);
    assert.equal(rfqLocalGuard.dbg0.apiTarget.url, "");
    assert.equal(rfqLocalGuard.bannerVisible, true);
    assert.equal(rfqLocalGuard.emptyActiveId, "rfqDemand", "N09: Empty RFQ submit must focus #rfqDemand");
    assert.equal(rfqLocalGuard.emptyAriaInvalid, "true");
    assert.equal(rfqLocalGuard.blockedErrVisible, true);
    assert.equal(apiHitsDuringLocalGuardTest, 0, "N09: rfq.html must make 0 API requests (including catalog) in local preview without ?api=");

    // 8.2 rfq.html with ?api=: N10 bilingual <option> + N07 idemKey reload persistence + REV10 zero recruitment + 360px 0px overflow
    await chrome.navigate(`${baseUrl}/rfq.html?api=${encodeURIComponent(baseUrl)}&ref=DISABLED_TEST_REF`);
    const rfqPreReload = await chrome.evalJs(`(() => {
      const optEn = document.querySelector('#rfqProductLine option[value="valves"]').textContent;
      document.getElementById("rfqDemand").value = "TEST Browser RFQ: need HDPE PE100 pipe DN250 for municipal project";
      document.getElementById("rfqDemand").dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("rfqCountry").value = "Vietnam";
      document.getElementById("rfqCountry").dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("rfqProductLine").value = "valves";
      document.getElementById("rfqProductLine").dispatchEvent(new Event("change", { bubbles: true }));
      document.getElementById("rfqContactVal").value = "browser.buyer@example.test";
      document.getElementById("rfqContactVal").dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("rfqPrivacyConsent").checked = true;
      document.getElementById("rfqPrivacyConsent").dispatchEvent(new Event("change", { bubbles: true }));
      const idemBeforeLang = window.__FG_RFQ_DEBUG__().idemKey;
      // N10: Toggle EN -> ZH -> EN and confirm <option> translates while form values & idemKey stay intact!
      document.getElementById("btnLangToggle").click();
      const optZh = document.querySelector('#rfqProductLine option[value="valves"]').textContent;
      const idemAfterZh = window.__FG_RFQ_DEBUG__().idemKey;
      document.getElementById("btnLangToggle").click();
      const optEnBack = document.querySelector('#rfqProductLine option[value="valves"]').textContent;
      return { optEn, optZh, optEnBack, idemBeforeLang, idemAfterZh };
    })()`);
    assert.notEqual(rfqPreReload.optEn, rfqPreReload.optZh, "N10: rfq.html <option> labels must translate between EN and ZH");
    assert.equal(rfqPreReload.optEn, rfqPreReload.optEnBack);
    assert.equal(rfqPreReload.idemBeforeLang, rfqPreReload.idemAfterZh, "N07/N10: Language toggle must NOT alter idemKey");

    // Reload rfq.html and assert draft + exact idemKey survive (N07)
    await chrome.send("Page.reload");
    await sleep(600);
    const rfqCheck = await chrome.evalJs(`(async () => {
      const idemAfterReload = window.__FG_RFQ_DEBUG__().idemKey;
      const demandRestored = document.getElementById("rfqDemand").value;
      const bodyTxt = document.body.innerText;
      const hasRecruitText = /加盟|合伙人|招商|代理返佣|招聘/i.test(bodyTxt);
      document.getElementById("btnSubmitRfq").click();
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (!document.getElementById("rfqSuccessBox").hidden) break;
      }
      return {
        idemAfterReload,
        demandRestored,
        hasRecruitText,
        refBannerHidden: document.getElementById("refBanner").hidden,
        hasCopyRefBtn: Boolean(document.getElementById("btnCopyRfqNo")),
        successText: document.getElementById("rfqSuccessBox").innerText
      };
    })()`);
    assert.equal(rfqCheck.idemAfterReload, rfqPreReload.idemBeforeLang, "N07: rfq.html idemKey MUST survive page reload");
    assert.ok(rfqCheck.demandRestored.includes("HDPE PE100"));
    assert.equal(rfqCheck.hasRecruitText, false, "REV10: rfq.html must contain zero partner/recruitment text");
    assert.equal(rfqCheck.refBannerHidden, true, "REV06: Invalid/disabled ref must stay hidden/neutral");
    assert.equal(rfqCheck.hasCopyRefBtn, true, "rfq.html receipt must expose one-click copy button");
    assert.ok(rfqCheck.successText.includes("FG-RFQ-"), "Buyer RFQ must render FG-RFQ receipt");

    await chrome.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 2, mobile: true });
    await sleep(150);
    const rfqMobileOverflow = await chrome.evalJs("Math.max(0, document.documentElement.scrollWidth - window.innerWidth)");
    assert.equal(rfqMobileOverflow, 0, "rfq.html must have 0px horizontal overflow at 360px mobile viewport");

    // 8.3 join.html with ?api=: N06 3x reload draft survival + N10 bilingual <option> + N07 lost-response reload replay deduplication!
    await chrome.navigate(`${baseUrl}/join.html?api=${encodeURIComponent(baseUrl)}`);
    const joinMobileOverflow = await chrome.evalJs("Math.max(0, document.documentElement.scrollWidth - window.innerWidth)");
    assert.equal(joinMobileOverflow, 0, "join.html must have 0px horizontal overflow at 360px mobile viewport");

    await chrome.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(120);
    const joinInit = await chrome.evalJs(`(() => {
      const marketingDefault = document.getElementById("marketingOptIn").checked;
      const optZh = document.querySelector('#partnerMode option[value="followup"]').textContent;
      // N10: Toggle ZH -> EN -> ZH and verify <option> translates
      document.getElementById("btnLangToggle").click();
      const optEn = document.querySelector('#partnerMode option[value="followup"]').textContent;
      document.getElementById("btnLangToggle").click();
      // Select tool_trial track & fill fields (N06)
      document.querySelector('.track-card[data-track="tool_trial"]').click();
      document.getElementById("appName").value = "TEST Chrome Reload Idem User";
      document.getElementById("appName").dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("contactValue").value = "chrome_reload_wx";
      document.getElementById("contactValue").dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("countryTz").value = "Singapore (UTC+8)";
      document.getElementById("countryTz").dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("experienceNote").value = "Valve export team trial";
      document.getElementById("experienceNote").dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("privacyConsent").checked = true;
      document.getElementById("privacyConsent").dispatchEvent(new Event("change", { bubbles: true }));
      const dbg = window.__FG_JOIN_DEBUG__();
      return { marketingDefault, optZh, optEn, idemKey: dbg.idemKey, track: dbg.track };
    })()`);
    assert.equal(joinInit.marketingDefault, false, "Marketing opt-in must default unchecked");
    assert.notEqual(joinInit.optZh, joinInit.optEn, "N10: join.html <option> labels must translate between ZH and EN");
    assert.equal(joinInit.track, "tool_trial");

    // N06 + N07: Reload join.html THREE CONSECUTIVE TIMES — draft fields, track AND idemKey must survive EVERY reload!
    for (let r = 1; r <= 3; r++) {
      await chrome.send("Page.reload");
      await sleep(500);
      const snap = await chrome.evalJs(`(() => {
        const dbg = window.__FG_JOIN_DEBUG__();
        return {
          track: dbg.track,
          idemKey: dbg.idemKey,
          appName: document.getElementById("appName").value,
          contactValue: document.getElementById("contactValue").value,
          countryTz: document.getElementById("countryTz").value,
          note: document.getElementById("experienceNote").value,
          consent: document.getElementById("privacyConsent").checked,
        };
      })()`);
      assert.equal(snap.track, "tool_trial", `N06 reload #${r}: track must survive`);
      assert.equal(snap.appName, "TEST Chrome Reload Idem User", `N06 reload #${r}: appName must survive`);
      assert.equal(snap.contactValue, "chrome_reload_wx", `N06 reload #${r}: contactValue must survive`);
      assert.equal(snap.countryTz, "Singapore (UTC+8)", `N06 reload #${r}: countryTz must survive`);
      assert.equal(snap.note, "Valve export team trial", `N06 reload #${r}: experienceNote must survive`);
      assert.equal(snap.consent, true, `N06 reload #${r}: privacyConsent must survive`);
      assert.equal(snap.idemKey, joinInit.idemKey, `N07 reload #${r}: idemKey must stay identical across reloads`);
    }

    // N07 Lost-Response Network Interruption -> Reload -> Resubmit -> Server receives IDENTICAL X-Idempotency-Key & creates ONLY 1 DB row!
    receivedPublicAppIdemKeys.length = 0;
    dropNextPublicAppResponseAfterCommit = true;
    const lostRespState = await chrome.evalJs(`(async () => {
      document.getElementById("btnSubmitJoin").click();
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (!document.getElementById("joinErrorBox").hidden) break;
      }
      return {
        errVisible: !document.getElementById("joinErrorBox").hidden,
        idemStillSaved: window.__FG_JOIN_DEBUG__().idemKey
      };
    })()`);
    assert.equal(lostRespState.errVisible, true, "N07: Lost network response should show retryable network error");
    assert.equal(lostRespState.idemStillSaved, joinInit.idemKey);

    await chrome.send("Page.reload");
    await sleep(500);
    const replaySubmit = await chrome.evalJs(`(async () => {
      const idemBeforeRetry = window.__FG_JOIN_DEBUG__().idemKey;
      document.getElementById("btnSubmitJoin").click();
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (!document.getElementById("joinSuccessBox").hidden) break;
      }
      return {
        idemBeforeRetry,
        receipt: document.getElementById("joinSuccessBox").innerText
      };
    })()`);
    assert.equal(replaySubmit.idemBeforeRetry, joinInit.idemKey);
    assert.ok(replaySubmit.receipt.includes("FG-APP-"), "N07: Reloaded retry must recover original FG-APP receipt");
    assert.equal(receivedPublicAppIdemKeys.length, 2);
    assert.equal(receivedPublicAppIdemKeys[0], receivedPublicAppIdemKeys[1], "N07: Server must receive identical X-Idempotency-Key across reload retry");
    const reloadAppCount = Number(
      db.raw.prepare("SELECT COUNT(*) AS cnt FROM applications WHERE applicant_name = 'TEST Chrome Reload Idem User'").get().cnt
    );
    assert.equal(reloadAppCount, 1, "N07: Lost-response + reload + retry MUST create ONLY 1 application row in D1!");

    // Fresh clean submission on join.html to confirm one-time secret + copy + status lookup flow
    await chrome.navigate(`${baseUrl}/join.html?api=${encodeURIComponent(baseUrl)}`);
    const joinCheck = await chrome.evalJs(`(async () => {
      document.getElementById("appName").value = "TEST Chrome Partner";
      document.getElementById("appName").dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("contactValue").value = "chrome_partner_wx";
      document.getElementById("contactValue").dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("privacyConsent").checked = true;
      document.getElementById("privacyConsent").dispatchEvent(new Event("change", { bubbles: true }));
      document.getElementById("btnSubmitJoin").click();
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (!document.getElementById("joinSuccessBox").hidden) break;
      }
      const receipt = document.getElementById("joinSuccessBox").innerText;
      const hasCopyReceiptBtn = Boolean(document.getElementById("btnCopyReceipt"));
      document.getElementById("btnGoCheckStatus").click();
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (!document.getElementById("statusResultBox").hidden) break;
      }
      return {
        hasCopyReceiptBtn,
        receipt,
        statusOut: document.getElementById("statusResultBox").innerText
      };
    })()`);
    assert.equal(joinCheck.hasCopyReceiptBtn, true, "join.html must provide one-click copy receipt/secret button");
    assert.ok(joinCheck.receipt.includes("FG-APP-") && joinCheck.receipt.includes("fglk_"));
    assert.ok(joinCheck.statusOut.includes("FG-APP-"));

    // 8.4 index.html: Real Chrome login + REV01 contextEpoch + ACQ04 scoped drafts + ALL 6 V3 Hub tabs + N02-UI + N08 Deep-Links!
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
      window.FG_V3.switchContext({ org_id: "org_other_iso", org_type: "independent_trial", org_name: "Other Org", role: "independent_user", membership_id: "mem_other" });
      const slowRes = await slowPromise;
      const otherDraft = window.FG_V3.loadScopedDraft("signal");

      // Switch back to main org & test all 6 operational tabs
      window.FG_V3.switchContext({ org_id: "org_friesgo_main", org_type: "company_main", org_name: "FriesGo Global", role: "super_admin", membership_id: "legacy_main" });
      const mainDraftRestored = window.FG_V3.loadScopedDraft("signal");

      await window.FG_V3_UI.openHub("todos");
      await new Promise((r) => setTimeout(r, 250));
      const todosTxt = document.getElementById("v3Body").innerText;

      window.FG_V3_UI.setTab("tasks");
      await new Promise((r) => setTimeout(r, 250));
      const tasksTxt = document.getElementById("v3Body").innerText;
      const hasTaskCurrencySelect = Boolean(document.getElementById("v3TaskCurrency"));

      window.FG_V3_UI.setTab("signals");
      await new Promise((r) => setTimeout(r, 300));
      const firstDraftBtn = document.querySelector("[data-gen-draft]");
      if (firstDraftBtn) firstDraftBtn.click();
      await new Promise((r) => setTimeout(r, 250));
      const signalsTxt = document.getElementById("v3Body").innerText;

      window.FG_V3_UI.setTab("compare");
      await new Promise((r) => setTimeout(r, 300));
      const compareTxt = document.getElementById("v3Body").innerText;
      const hasDateRangeInputs = Boolean(document.getElementById("v3CmpFrom") && document.getElementById("v3CmpTo"));

      // N03-UI & Export Check #1: Thailand 2026-11-01..2026-11-27 -> period 13.0h / USD 20.00, cumulative ref 28.0h / JPY 200 + USD 70.00
      document.getElementById("v3CmpCountry").value = "Thailand";
      document.getElementById("v3CmpProd").value = "";
      document.getElementById("v3CmpFrom").value = "2026-11-01";
      document.getElementById("v3CmpTo").value = "2026-11-27";
      document.getElementById("v3BtnRunCmp").click();
      await new Promise((r) => setTimeout(r, 350));
      const cmpW2Txt = document.getElementById("v3Body").innerText;
      const cmpW2Md = String(window.__FG_V3_LAST_COMPARE_MD__ || "");

      // N03-UI & Export Check #2: Thailand 2026-11-28..2026-11-28 -> period 5.0h / JPY 200 (NOT 13.0h / USD 20.00 or 28.0h!)
      document.getElementById("v3CmpFrom").value = "2026-11-28";
      document.getElementById("v3CmpTo").value = "2026-11-28";
      document.getElementById("v3BtnRunCmp").click();
      await new Promise((r) => setTimeout(r, 350));
      const cmpW3Txt = document.getElementById("v3Body").innerText;
      const cmpW3Md = String(window.__FG_V3_LAST_COMPARE_MD__ || "");

      // I01-UI & Export Check: Concurrent Malaysia tasks (2026-08-01..2026-08-03) -> FB 12.0h / USD 1.20 & IG 11.5h / JPY 200 + USD 2.00
      document.getElementById("v3CmpCountry").value = "Malaysia";
      document.getElementById("v3CmpFrom").value = "2026-08-01";
      document.getElementById("v3CmpTo").value = "2026-08-03";
      document.getElementById("v3BtnRunCmp").click();
      await new Promise((r) => setTimeout(r, 350));
      const cmpMyTxt = document.getElementById("v3Body").innerText;
      const cmpMyMd = String(window.__FG_V3_LAST_COMPARE_MD__ || "");

      // Reset compare filters so 360px mobile overflow tests full unfiltered table
      document.getElementById("v3CmpCountry").value = "";
      document.getElementById("v3CmpFrom").value = "";
      document.getElementById("v3CmpTo").value = "";
      document.getElementById("v3BtnRunCmp").click();
      await new Promise((r) => setTimeout(r, 250));

      window.FG_V3_UI.setTab("projects");
      await new Promise((r) => setTimeout(r, 250));
      const projectsTxt = document.getElementById("v3Body").innerText;

      window.FG_V3_UI.setTab("admin");
      await new Promise((r) => setTimeout(r, 250));
      const adminTxt = document.getElementById("v3Body").innerText;

      return {
        epochBefore,
        epochAfter: window.FG_V3.getContextEpoch(),
        slowRes,
        otherDraft,
        mainDraftRestored,
        hasTaskCurrencySelect,
        hasDateRangeInputs,
        tasksTxt,
        cmpW2Txt,
        cmpW2Md,
        cmpW3Txt,
        cmpW3Md,
        cmpMyTxt,
        cmpMyMd,
        todosOk: todosTxt.includes("复制微信脱敏卡"),
        tasksOk: tasksTxt.includes("Facebook") && tasksTxt.includes("Instagram") && tasksTxt.includes("LinkedIn") && tasksTxt.includes("YouTube"),
        signalsOk: signalsTxt.includes("可编辑回复草稿") && signalsTxt.includes("不计触达"),
        compareOk: compareTxt.includes("facebook") && compareTxt.includes("manual_discovery") && compareTxt.includes("复制周复盘 Markdown"),
        compareMultiCurrencyOk: compareTxt.includes("JPY 200 + USD 1.00") && compareTxt.includes("零产出投入"),
        projectsOk: projectsTxt.includes("主管可见查重提示") && projectsTxt.includes("创建轻量工程"),
        adminOk: adminTxt.includes("入驻申请审批与分离激活") && adminTxt.includes("核验产品目录与认证维护"),
      };
    })()`);
    assert.equal(epochCheck.slowRes.staleContext, true, "REV01: Stale in-flight response MUST be discarded on context switch");
    assert.equal(epochCheck.slowRes.code, "STALE_CONTEXT_DISCARDED");
    assert.equal(epochCheck.otherDraft, null, "ACQ04: Draft from Org Main MUST NOT leak into Other Org");
    assert.equal(epochCheck.mainDraftRestored.demand_summary, "MAIN_ORG_SECRET_DRAFT");
    assert.equal(epochCheck.hasTaskCurrencySelect, true, "N02-UI: Task form must expose currency selector");
    assert.equal(epochCheck.hasDateRangeInputs, true, "N04-UI: Compare tab must expose from/to date inputs");
    assert.equal(epochCheck.todosOk, true, "Tab 1 todos + WeChat card must render");
    assert.equal(epochCheck.tasksOk, true, "Tab 2 FB/IG/LI/YT platform strip must render");
    assert.equal(epochCheck.signalsOk, true, "Tab 3 editable draft drawer must render");
    assert.equal(epochCheck.compareOk, true, "Tab 4 source comparison + Markdown export must render");
    assert.equal(epochCheck.compareMultiCurrencyOk, true, "N02-UI/N03-UI: Compare tab must render 'JPY 200 + USD 1.00' and '零产出投入' badge");
    // N03-UI & Markdown Export exact period vs cumulative reconciliation assertions
    assert.ok(epochCheck.cmpW2Txt.includes("13.0") && epochCheck.cmpW2Txt.includes("USD 20.00"), "N03-UI W2: Must display period 13.0h and USD 20.00");
    assert.ok(epochCheck.cmpW2Txt.includes("累计参考：28.0h / JPY 200 + USD 70.00"), "N03-UI W2: Must display separated cumulative_reference");
    assert.ok(epochCheck.cmpW2Md.includes("| 13.0 | USD 20.00 | 28.0h / JPY 200 + USD 70.00 |"), "N03-Export W2: Markdown export must match period & cumulative figures");
    assert.ok(epochCheck.cmpW3Txt.includes("5.0") && epochCheck.cmpW3Txt.includes("JPY 200"), "N03-UI W3: Must display period 5.0h and JPY 200");
    assert.ok(!epochCheck.cmpW3Md.includes("| 13.0 | USD 20.00 |"), "N03-Export W3: Nov 28 export must NOT repeat Nov 1-27 period effort");
    assert.ok(epochCheck.cmpW3Md.includes("| 5.0 | JPY 200 | 28.0h / JPY 200 + USD 70.00 |"), "N03-Export W3: Nov 28 Markdown export must match exact period 5.0h / JPY 200");
    // I01-UI & Export reconciliation assertions for concurrent Malaysia tasks (Tab 2 Tasks === Tab 4 Compare === Exported Markdown!)
    assert.ok(epochCheck.tasksTxt.includes("12.0h") && epochCheck.tasksTxt.includes("USD 1.20"), "I01-UI Tab2: Same-cur concurrent task must show reconciled 12.0h & USD 1.20");
    assert.ok(epochCheck.tasksTxt.includes("11.5h") && epochCheck.tasksTxt.includes("JPY 200 + USD 2.00"), "I01-UI Tab2: Cross-cur concurrent task must show reconciled 11.5h & JPY 200 + USD 2.00");
    assert.ok(epochCheck.cmpMyTxt.includes("12.0") && epochCheck.cmpMyTxt.includes("USD 1.20"), "I01-UI Tab4: Compare table must reconcile 12.0h & USD 1.20");
    assert.ok(epochCheck.cmpMyTxt.includes("11.5") && epochCheck.cmpMyTxt.includes("JPY 200 + USD 2.00"), "I01-UI Tab4: Compare table must reconcile 11.5h & JPY 200 + USD 2.00");
    assert.ok(epochCheck.cmpMyMd.includes("| 12.0 | USD 1.20 | 12.0h / USD 1.20 |"), "I01-Export: Markdown must match reconciled concurrent FB task");
    assert.ok(epochCheck.cmpMyMd.includes("| 11.5 | JPY 200 + USD 2.00 | 11.5h / JPY 200 + USD 2.00 |"), "I01-Export: Markdown must match reconciled concurrent IG task");
    assert.equal(epochCheck.projectsOk, true, "Tab 5 projects + blind-dedupe manager hints must render");
    assert.equal(epochCheck.adminOk, true, "Tab 6 applications inbox + catalog manager must render");

    // Verify 360px mobile 0px horizontal overflow across all 6 Hub tabs (including multi-currency compare!)
    await chrome.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 2, mobile: true });
    for (const tabKey of ["todos", "tasks", "signals", "compare", "projects", "admin"]) {
      await chrome.evalJs(`(async () => { window.FG_V3_UI.setTab(${JSON.stringify(tabKey)}); await new Promise((r) => setTimeout(r, 200)); })()`);
      const ov = await chrome.evalJs("Math.max(0, document.documentElement.scrollWidth - window.innerWidth)");
      assert.equal(ov, 0, `V3 Hub tab "${tabKey}" must have 0px horizontal overflow at 360px mobile viewport`);
    }

    // 8.5 N08 Deep-Link Real Browser Landing Tests (Found + Missing + Unauthorized Org!)
    await chrome.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.navigate(`${baseUrl}/index.html?v3_org=org_friesgo_main&v3_todo=${encodeURIComponent(validDeepLinkTodoId)}#v3-todo=${encodeURIComponent(validDeepLinkTodoId)}`);
    await sleep(600);
    const dlFound = await chrome.evalJs(`(async () => {
      for (let i = 0; i < 20; i++) {
        if (document.getElementById("v3DeepLinkFoundNotice")) break;
        await new Promise((r) => setTimeout(r, 120));
      }
      const notice = document.getElementById("v3DeepLinkFoundNotice");
      const highlighted = document.querySelector('.v3-deeplink-highlight[data-todo-id="' + ${JSON.stringify(validDeepLinkTodoId)} + '"]');
      return { foundNotice: Boolean(notice), highlighted: Boolean(highlighted) };
    })()`);
    assert.equal(dlFound.foundNotice, true, "N08: Valid deep-link must open V3 Hub and render #v3DeepLinkFoundNotice");
    assert.equal(dlFound.highlighted, true, "N08: Valid deep-link must highlight the exact target todo card");

    await chrome.navigate(`${baseUrl}/index.html?v3_org=org_friesgo_main&v3_todo=asg_nonexistent_999#v3-todo=asg_nonexistent_999`);
    await sleep(600);
    const dlMissing = await chrome.evalJs(`(async () => {
      for (let i = 0; i < 20; i++) {
        if (document.getElementById("v3DeepLinkMissingNotice")) break;
        await new Promise((r) => setTimeout(r, 120));
      }
      return Boolean(document.getElementById("v3DeepLinkMissingNotice"));
    })()`);
    assert.equal(dlMissing, true, "N08: Missing/reassigned deep-link todo must render neutral #v3DeepLinkMissingNotice");

    await chrome.navigate(`${baseUrl}/index.html?v3_org=org_unauth_999&v3_todo=asg_1#v3-todo=asg_1`);
    await sleep(600);
    const dlUnauth = await chrome.evalJs(`(async () => {
      for (let i = 0; i < 20; i++) {
        if (document.getElementById("v3DeepLinkUnauthNotice")) break;
        await new Promise((r) => setTimeout(r, 120));
      }
      return Boolean(document.getElementById("v3DeepLinkUnauthNotice"));
    })()`);
    assert.equal(dlUnauth, true, "N08: Unauthorized org deep-link must render neutral #v3DeepLinkUnauthNotice");

    assert.equal(chrome.pageErrors.length, 0, "Zero uncaught Chrome pageErrors: " + chrome.pageErrors.join(" | "));

    console.log("PASS BLOCK 8 (Real Headless Chrome Desktop + 360px Mobile): N09 localhost guard + client validation, N10 bilingual <option>, N06 3x reload draft, N07 lost-response reload replay, N08 deep-link (found/missing/unauth), N02-UI USD+JPY, REV01 contextEpoch, ACQ04 scoped drafts, 0px mobile overflow & 0 pageErrors verified");
  } finally {
    await chrome.close();
    server.close();
  }

  console.log("\nALL V3 SLICE-1 DIRECTED VERIFICATION BLOCKS (1–8, S01–S08, N01–N10) PASSED!");
}

main().catch((err) => {
  console.error("V3 SLICE-1 VERIFICATION FAILED:", err);
  process.exit(1);
});
