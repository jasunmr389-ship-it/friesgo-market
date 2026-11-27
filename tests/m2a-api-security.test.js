// Comprehensive M2-A Backend Security, 2FA, Atomic Lock, Dedupe, Migration & Backup/Restore Drill Test Suite
// Runs the real Cloudflare Worker modules against Node 24 built-in SQLite (real 0001_init.sql schema, zero SQL mocks).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import worker from "../workers/friesgo-api/src/index.js";
import { generateTotpCode } from "../workers/friesgo-api/src/totp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = fs.readFileSync(
  path.resolve(__dirname, "..", "workers", "friesgo-api", "migrations", "0001_init.sql"),
  "utf8"
);

/**
 * Real SQLite-backed Cloudflare D1 compatible adapter for exact SQL verification.
 */
function createSqliteD1() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(SCHEMA_SQL);

  function wrapStmt(sql, params = []) {
    return {
      bind(...args) {
        return wrapStmt(sql, args);
      },
      async first() {
        const stmt = raw.prepare(sql);
        const row = stmt.get(...params);
        return row === undefined ? null : { ...row };
      },
      async all() {
        const stmt = raw.prepare(sql);
        const rows = stmt.all(...params);
        return { results: rows.map((r) => ({ ...r })), success: true };
      },
      async run() {
        const stmt = raw.prepare(sql);
        const info = stmt.run(...params);
        return {
          success: true,
          meta: { changes: Number(info.changes || 0), last_row_id: Number(info.lastInsertRowid || 0) },
        };
      },
    };
  }

  return {
    raw,
    prepare(sql) {
      return wrapStmt(sql, []);
    },
  };
}

function makeEnv(db, overrides = {}) {
  return {
    DB: db,
    ENVIRONMENT: "staging",
    ALLOWED_ORIGINS: "https://jasunmr389-ship-it.github.io,http://127.0.0.1",
    AUTH_PEPPER: "test_pepper_32_chars_minimum_9876543210",
    TOTP_ENC_KEY: Buffer.alloc(32, 7).toString("base64"),
    BOOTSTRAP_SECRET: "boot_secret_one_time_9876543210",
    LOCK_TTL_SECONDS: "600",
    SESSION_TTL_DAYS: "30",
    GMAPS_TEAM_MONTHLY_CAP: "3",
    GMAPS_EMP_MONTHLY_CAP: "2",
    GOOGLE_MAPS_API_KEY: "test_gmaps_key",
    ...overrides,
  };
}

async function req(env, method, pathname, { token, body, headers = {}, origin = "https://jasunmr389-ship-it.github.io" } = {}) {
  const hdrs = { ...headers };
  if (origin) hdrs.Origin = origin;
  if (token) hdrs.Authorization = `Bearer ${token}`;
  if (body !== undefined) hdrs["Content-Type"] = "application/json";
  const r = await worker.fetch(
    new Request(`https://api.test${pathname}`, {
      method,
      headers: hdrs,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    env
  );
  const text = await r.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { rawText: text };
  }
  return { status: r.status, headers: r.headers, json };
}

test("M2-A Full Security, 2FA, Atomic Locks, Dedupe, Migration, Paid Proxy & Restore Drill", async () => {
  const db = createSqliteD1();
  const capturedGmapsMasks = [];
  const env = makeEnv(db, {
    _mockGmapsFetch: async (_url, opts) => {
      capturedGmapsMasks.push(opts.headers["X-Goog-FieldMask"]);
      return new Response(
        JSON.stringify({
          places: [
            {
              id: "ChIJTestPlaceId001",
              displayName: { text: "Gulf Valves LLC" },
              formattedAddress: "Dammam, Saudi Arabia",
            },
          ],
          nextPageToken: "",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  // ===== 1. External Visitor Isolation & Strict CORS =====
  const h1 = await req(env, "GET", "/api/health");
  assert.equal(h1.status, 200);
  assert.equal(h1.json.bootstrapped, false);
  assert.ok(h1.headers.get("Cache-Control").includes("no-store"));

  const evilCors = await req(env, "GET", "/api/companies", { origin: "https://evil-scraper.com" });
  assert.equal(evilCors.status, 403);
  assert.equal(evilCors.json.code, "ORIGIN_DENIED");

  for (const [m, p] of [
    ["GET", "/api/companies"],
    ["POST", "/api/locks/acquire"],
    ["POST", "/api/events"],
    ["POST", "/api/feedback"],
    ["POST", "/api/gmaps/search"],
    ["GET", "/api/admin/employees"],
  ]) {
    const unauth = await req(env, m, p, { body: m === "POST" ? {} : undefined });
    assert.equal(unauth.status, 401, `External visitor must get 401 on ${m} ${p}`);
    assert.ok(unauth.headers.get("Cache-Control").includes("no-store"));
  }

  // ===== 2. Bootstrap + Mandatory Super-Admin 2FA + Brute Force Lockout =====
  const badBoot = await req(env, "POST", "/api/auth/bootstrap", {
    headers: { "X-Bootstrap-Secret": "wrong_secret" },
    body: { login_id: "boss", display_name: "老板", password: "BossPassword123" },
  });
  assert.equal(badBoot.status, 401);

  const okBoot = await req(env, "POST", "/api/auth/bootstrap", {
    headers: { "X-Bootstrap-Secret": env.BOOTSTRAP_SECRET },
    body: { login_id: "boss", display_name: "业务负责人", password: "BossPassword123" },
  });
  assert.equal(okBoot.status, 201);

  // Second bootstrap MUST fail
  const dupBoot = await req(env, "POST", "/api/auth/bootstrap", {
    headers: { "X-Bootstrap-Secret": env.BOOTSTRAP_SECRET },
    body: { login_id: "hacker", display_name: "H", password: "HackerPass123" },
  });
  assert.equal(dupBoot.status, 409);

  // Brute force lockout test on fake IP
  for (let i = 0; i < 6; i++) {
    const fail = await req(env, "POST", "/api/auth/login", {
      headers: { "CF-Connecting-IP": "10.9.9.9" },
      body: { login_id: "boss", password: "WrongPassword9" },
    });
    assert.equal(fail.status, i === 5 ? 429 : 401);
  }
  const lockedAttempt = await req(env, "POST", "/api/auth/login", {
    headers: { "CF-Connecting-IP": "10.9.9.9" },
    body: { login_id: "boss", password: "BossPassword123" },
  });
  assert.equal(lockedAttempt.status, 429);

  // Super-admin login before 2FA enrollment -> restricted session
  const bossLogin1 = await req(env, "POST", "/api/auth/login", {
    headers: { "CF-Connecting-IP": "10.1.1.1" },
    body: { login_id: "boss", password: "BossPassword123", device_label: "Boss Mac" },
  });
  assert.equal(bossLogin1.status, 200);
  assert.equal(bossLogin1.json.requireTotpSetup, true);
  const bossToken = bossLogin1.json.token;

  // Cannot access business endpoints before finishing 2FA setup!
  const blockedBefore2fa = await req(env, "GET", "/api/companies", { token: bossToken });
  assert.equal(blockedBefore2fa.status, 403);
  assert.equal(blockedBefore2fa.json.code, "TOTP_SETUP_REQUIRED");

  // Setup & confirm TOTP 2FA
  const totpSetup = await req(env, "POST", "/api/auth/totp/setup", { token: bossToken });
  assert.equal(totpSetup.status, 200);
  assert.ok(totpSetup.json.secretBase32.length >= 16);
  assert.equal(totpSetup.json.recoveryCodes.length, 8);
  const bossSecret = totpSetup.json.secretBase32;
  const firstRecovery = totpSetup.json.recoveryCodes[0];

  const badConfirm = await req(env, "POST", "/api/auth/totp/confirm", {
    token: bossToken,
    body: { totp_code: "000000" },
  });
  assert.equal(badConfirm.status, 400);

  const liveTotp = await generateTotpCode(bossSecret);
  const okConfirm = await req(env, "POST", "/api/auth/totp/confirm", {
    token: bossToken,
    body: { totp_code: liveTotp },
  });
  assert.equal(okConfirm.status, 200);

  // Next super-admin login requires TOTP, accepts single-use recovery code once, and rejects replay!
  const bossPrompt = await req(env, "POST", "/api/auth/login", {
    headers: { "CF-Connecting-IP": "10.1.1.2" },
    body: { login_id: "boss", password: "BossPassword123" },
  });
  assert.equal(bossPrompt.json.requireTotp, true);

  const bossRecLogin = await req(env, "POST", "/api/auth/login", {
    headers: { "CF-Connecting-IP": "10.1.1.2" },
    body: { login_id: "boss", password: "BossPassword123", totp_code: firstRecovery },
  });
  assert.equal(bossRecLogin.status, 200);

  const bossRecReplay = await req(env, "POST", "/api/auth/login", {
    headers: { "CF-Connecting-IP": "10.1.1.2" },
    body: { login_id: "boss", password: "BossPassword123", totp_code: firstRecovery },
  });
  assert.equal(bossRecReplay.status, 401);

  // ===== 3. Employee Lifecycle, Role Enforcement & Per-Device Revocation =====
  const createWithoutTotp = await req(env, "POST", "/api/admin/employees", {
    token: bossToken,
    body: { login_id: "alice", display_name: "业务员A", role: "staff", password: "AlicePass123" },
  });
  assert.equal(createWithoutTotp.status, 403);
  assert.equal(createWithoutTotp.json.code, "ADMIN_TOTP_REQUIRED");

  const codeNow = await generateTotpCode(bossSecret);
  const cAlice = await req(env, "POST", "/api/admin/employees", {
    token: bossToken,
    body: { login_id: "alice", display_name: "业务员A", role: "staff", password: "AlicePass123", gmaps_monthly_cap: 2, totp_code: codeNow },
  });
  assert.equal(cAlice.status, 201);
  const aliceId = cAlice.json.employee.id;

  const cBob = await req(env, "POST", "/api/admin/employees", {
    token: bossToken,
    body: { login_id: "bob", display_name: "业务员B", role: "staff", password: "BobPass1234", gmaps_monthly_cap: 2, totp_code: codeNow },
  });
  assert.equal(cBob.status, 201);

  // Alice logs in on 2 devices; Bob logs in on 1 device
  const aliceDev1 = await req(env, "POST", "/api/auth/login", {
    body: { login_id: "alice", password: "AlicePass123", device_label: "Alice Phone" },
  });
  const aliceDev2 = await req(env, "POST", "/api/auth/login", {
    body: { login_id: "alice", password: "AlicePass123", device_label: "Alice Laptop" },
  });
  const bobLogin = await req(env, "POST", "/api/auth/login", {
    body: { login_id: "bob", password: "BobPass1234", device_label: "Bob Phone" },
  });
  assert.equal(aliceDev1.status, 200);
  assert.equal(aliceDev2.status, 200);
  assert.equal(bobLogin.status, 200);
  const aliceToken1 = aliceDev1.json.token;
  const aliceToken2 = aliceDev2.json.token;
  const bobToken = bobLogin.json.token;

  // Staff cannot access admin API even by forging role in body
  const staffAdmin = await req(env, "GET", "/api/admin/employees", { token: aliceToken1 });
  assert.equal(staffAdmin.status, 403);

  // ===== 4. Unified Company Pool, Batch Dedupe, Suspect Subsidiaries, ODbL OSM & Lossless Merge =====
  const gmapsRawBlock = await req(env, "POST", "/api/companies", {
    token: aliceToken1,
    body: { canonical_name: "Blocked Google Raw", country_en: "Vietnam", source_type: "gmaps_raw" },
  });
  assert.equal(gmapsRawBlock.status, 400);
  assert.equal(gmapsRawBlock.json.code, "GMAPS_TERMS_BLOCKED");

  const comp1Res = await req(env, "POST", "/api/companies", {
    token: aliceToken1,
    body: {
      canonical_name: "Saigon Industrial Valve JSC",
      country_en: "Vietnam",
      city: "Ho Chi Minh City",
      website: "https://saigonvalve.vn",
      email: "procurement@saigonvalve.vn",
      phone: "+84 28 3899 1122",
      product_summary: "工业阀门",
      source_type: "website",
    },
  });
  assert.equal(comp1Res.status, 201);
  const comp1Id = comp1Res.json.company.id;

  // Bob sees Alice's company immediately (team sharing)
  const bobList = await req(env, "GET", "/api/companies?country=Vietnam", { token: bobToken });
  assert.equal(bobList.status, 200);
  assert.equal(bobList.json.total, 1);
  assert.equal(bobList.json.items[0].id, comp1Id);

  // Batch dedupe: exact match vs group subsidiary (shared domain, different name/country -> suspect_duplicate, NOT auto-merged!) vs new
  const dedupe = await req(env, "POST", "/api/companies/dedupe-batch", {
    token: bobToken,
    body: {
      items: [
        { company: "Saigon Industrial Valve Co., Ltd.", country: "Vietnam", city: "Ho Chi Minh City", website: "saigonvalve.vn" },
        { company: "Saigon Valve Thailand Subsidiary", country: "Thailand", city: "Bangkok", website: "https://saigonvalve.vn" },
        { company: "Riyadh Desert Piping LLC", country: "Saudi Arabia", city: "Riyadh", website: "https://riyadhpiping.sa" },
      ],
    },
  });
  assert.equal(dedupe.status, 200);
  assert.equal(dedupe.json.results[0].status, "high_match");
  assert.equal(dedupe.json.results[1].status, "suspect_duplicate");
  assert.equal(dedupe.json.results[2].status, "new");

  // Optimistic version conflict check
  const patch1 = await req(env, "PATCH", `/api/companies/${comp1Id}`, {
    token: aliceToken1,
    body: { expected_version: 1, product_summary: "工业阀门 / PE管道" },
  });
  assert.equal(patch1.status, 200);
  assert.equal(patch1.json.company.version, 2);

  const stalePatch = await req(env, "PATCH", `/api/companies/${comp1Id}`, {
    token: bobToken,
    body: { expected_version: 1, product_summary: "旧副本覆盖尝试" },
  });
  assert.equal(stalePatch.status, 409);
  assert.equal(stalePatch.json.code, "VERSION_CONFLICT");

  // Physically isolated OSM Raw Pool (ODbL)
  const osmIng = await req(env, "POST", "/api/osm-pool/ingest", {
    token: aliceToken1,
    body: {
      items: [
        { _source: "osm", company: "Haiphong Steel Works", country: "Vietnam", city: "Haiphong", mapsUrl: "https://www.openstreetmap.org/?mlat=20.8&mlon=106.6" },
        { _source: "gmaps", company: "Must Never Enter OSM Pool", country: "Vietnam", city: "Hanoi" },
      ],
    },
  });
  assert.equal(osmIng.status, 200);
  assert.equal(osmIng.json.ingested, 1);

  const osmList = await req(env, "GET", "/api/osm-pool", { token: bobToken });
  assert.equal(osmList.json.items.length, 1);
  const osmProm = await req(env, "POST", `/api/osm-pool/${osmList.json.items[0].id}/promote`, {
    token: bobToken,
    body: { product_summary: "钢结构" },
  });
  assert.equal(osmProm.status, 201);
  const comp2Id = osmProm.json.companyId;

  // ===== 5. Atomic Short-Term Lock (lock_id + session_id), Colleague History & Opt-Out Hard Block =====
  const [lockA, lockB, lockADev2] = await Promise.all([
    req(env, "POST", "/api/locks/acquire", { token: aliceToken1, body: { company_id: comp1Id, channel: "email" } }),
    req(env, "POST", "/api/locks/acquire", { token: bobToken, body: { company_id: comp1Id, channel: "phone" } }),
    req(env, "POST", "/api/locks/acquire", { token: aliceToken2, body: { company_id: comp1Id, channel: "whatsapp" } }),
  ]);
  const winners = [lockA, lockB, lockADev2].filter((x) => x.status === 200);
  const losers = [lockA, lockB, lockADev2].filter((x) => x.status === 409);
  assert.equal(winners.length, 1, "Exactly ONE concurrent acquire must win");
  assert.equal(losers.length, 2, "Other employee AND other device of same employee must be blocked with 409");

  const winnerToken = lockA.status === 200 ? aliceToken1 : lockB.status === 200 ? bobToken : aliceToken2;
  const otherToken = winnerToken === aliceToken1 ? bobToken : aliceToken1;
  const winLockId = winners[0].json.lock.lock_id;

  // Other user or wrong lock_id CANNOT release the lock!
  const wrongUserRel = await req(env, "POST", "/api/locks/release", {
    token: otherToken,
    body: { company_id: comp1Id, lock_id: winLockId },
  });
  assert.equal(wrongUserRel.status, 403);
  const wrongIdRel = await req(env, "POST", "/api/locks/release", {
    token: winnerToken,
    body: { company_id: comp1Id, lock_id: "lck_forged_999" },
  });
  assert.equal(wrongIdRel.status, 403);

  // Winner logs real outreach event (idempotent!) & releases lock atomically
  const evId = "ev_unique_001";
  const ev1 = await req(env, "POST", "/api/events", {
    token: winnerToken,
    body: {
      event_id: evId,
      company_id: comp1Id,
      channel: "email",
      action_outcome: "sent",
      summary: "已发送阀门产品清单与初步参考报价",
      next_follow_date: "2026-12-01",
      release_lock_id: winLockId,
    },
  });
  assert.equal(ev1.status, 201);
  assert.equal(ev1.json.derived_contact_status, "contacted_no_reply");

  // Duplicate retry of same event_id is idempotent
  const evDup = await req(env, "POST", "/api/events", {
    token: winnerToken,
    body: { event_id: evId, company_id: comp1Id, channel: "email", action_outcome: "sent", summary: "retry" },
  });
  assert.equal(evDup.status, 200);
  assert.equal(evDup.json.idempotentDuplicate, true);

  // Now the OTHER colleague tries to contact -> succeeds lock AND receives colleagueHistory warning!
  const colLock = await req(env, "POST", "/api/locks/acquire", {
    token: otherToken,
    body: { company_id: comp1Id, channel: "phone" },
  });
  assert.equal(colLock.status, 200);
  assert.equal(colLock.json.hasColleagueHistory, true);
  assert.ok(colLock.json.colleagueHistory.length >= 1);

  // Record unsubscribe -> HARD BLOCKS all future outreach & cannot be downgraded!
  const unsubEv = await req(env, "POST", "/api/events", {
    token: otherToken,
    body: {
      event_id: "ev_unsub_001",
      company_id: comp1Id,
      channel: "email",
      action_outcome: "unsubscribed",
      summary: "客户回复不再采购，请求退订",
      release_lock_id: colLock.json.lock.lock_id,
    },
  });
  assert.equal(unsubEv.status, 201);
  assert.equal(unsubEv.json.derived_contact_status, "stopped");

  const blockedLock = await req(env, "POST", "/api/locks/acquire", {
    token: aliceToken1,
    body: { company_id: comp1Id, channel: "email" },
  });
  assert.equal(blockedLock.status, 403);
  assert.equal(blockedLock.json.code, "OPT_OUT_BLOCKED");

  // Attempt to downgrade opt_out_status via PATCH -> MUST stay all_blocked!
  const detailBefore = await req(env, "GET", `/api/companies/${comp1Id}`, { token: aliceToken1 });
  const tryDowngrade = await req(env, "PATCH", `/api/companies/${comp1Id}`, {
    token: aliceToken1,
    body: { expected_version: detailBefore.json.company.version, opt_out_status: "none" },
  });
  assert.equal(tryDowngrade.status, 200);
  assert.equal(tryDowngrade.json.company.opt_out_status, "all_blocked");

  // Lossless Merge & Unmerge test
  const mrg = await req(env, "POST", "/api/companies/merge", {
    token: bossToken,
    body: { source_id: comp2Id, target_id: comp1Id },
  });
  assert.equal(mrg.status, 200);
  const unmrg = await req(env, "POST", "/api/companies/unmerge", {
    token: bossToken,
    body: { audit_id: mrg.json.auditId },
  });
  assert.equal(unmrg.status, 200);

  // ===== 6. Idempotent 6-Step IndexedDB Migration (Dry-Run + Double Commit) =====
  const legacyPayload = {
    batch_id: "mig_batch_alice_01",
    leads: [
      {
        id: comp1Id, // Matches existing unsubscribed company -> must NEVER clear opt_out!
        company: "Saigon Industrial Valve JSC",
        country: "Vietnam",
        stage: "跟进中",
        timeline: [{ tlId: "tl_legacy_1", channel: "邮件", result: "历史老记录", ts: "2026-11-10 10:00" }],
        quotes: [{ quoteId: "qt_legacy_1", refNo: "FG-20261110-01", quoteTier: "formal", fobUsd: 12000 }],
      },
      {
        id: "crm_legacy_mx_01",
        company: "Monterrey Acero SA",
        country: "Mexico",
        city: "Monterrey",
        email: "compras@monterreyacero.mx",
        dd: { verdict: "pass", reg: true, sanc: true },
        timeline: [{ tlId: "tl_legacy_mx_1", channel: "WhatsApp", result: "已发送目录", ts: "2026-11-20 09:00" }],
      },
    ],
    complianceLogs: [{ logId: "pcl_legacy_1", orderRef: "ORD-001", clientId: "crm_legacy_mx_01", decision: "approved", checks: { c1: true } }],
  };

  const dry = await req(env, "POST", "/api/migrate/dry-run", { token: aliceToken1, body: legacyPayload });
  assert.equal(dry.status, 200);
  assert.equal(dry.json.summary.createCount, 1);
  assert.equal(dry.json.summary.mergeHighCount, 1);

  const mig1 = await req(env, "POST", "/api/migrate/commit", { token: aliceToken1, body: legacyPayload });
  assert.equal(mig1.status, 200);
  assert.equal(mig1.json.report.companiesCreated, 1);
  assert.equal(mig1.json.report.eventsInserted, 2);

  // Repeat exact same migration -> 0 new events, 0 duplicate companies, opt-out preserved!
  const mig2 = await req(env, "POST", "/api/migrate/commit", { token: aliceToken1, body: legacyPayload });
  assert.equal(mig2.status, 200);
  assert.equal(mig2.json.report.companiesCreated, 0);
  assert.equal(mig2.json.report.eventsInserted, 0);
  const comp1AfterMig = await req(env, "GET", `/api/companies/${comp1Id}`, { token: aliceToken1 });
  assert.equal(comp1AfterMig.json.company.opt_out_status, "all_blocked", "Re-migration MUST NOT clear opt_out_status");

  // ===== 7. Paid Google Maps Proxy (Auth + Per-Emp & Team Caps + places.id + no-store) =====
  const g1 = await req(env, "POST", "/api/gmaps/search", { token: aliceToken1, body: { textQuery: "valve Dammam" } });
  const g2 = await req(env, "POST", "/api/gmaps/search", { token: aliceToken1, body: { textQuery: "pump Dammam" } });
  const g3 = await req(env, "POST", "/api/gmaps/search", { token: aliceToken1, body: { textQuery: "pipe Dammam" } });
  assert.equal(g1.status, 200);
  assert.equal(g2.status, 200);
  assert.equal(g3.status, 429);
  assert.equal(g3.json.code, "EMP_QUOTA_EXCEEDED");
  assert.ok(capturedGmapsMasks[0].includes("places.id"));
  assert.ok(g1.headers.get("Cache-Control").includes("no-store"));

  // Bob uses 3rd team slot, 4th blocked by team cap (3)
  const gBob1 = await req(env, "POST", "/api/gmaps/search", { token: bobToken, body: { textQuery: "steel Riyadh" } });
  const gBob2 = await req(env, "POST", "/api/gmaps/search", { token: bobToken, body: { textQuery: "cable Riyadh" } });
  assert.equal(gBob1.status, 200);
  assert.equal(gBob2.status, 429);
  assert.equal(gBob2.json.code, "TEAM_QUOTA_EXCEEDED");

  // ===== 8. Cloud Co-Creation Feedback Board (PII Redaction + Admin Reply) =====
  const fbPost = await req(env, "POST", "/api/feedback", {
    token: bobToken,
    body: {
      category: "步骤繁琐",
      content: "联系 test@buyer.mx 电话 +52 81 8345 6789 访问 https://secret.mx/a 时希望更快",
      context: { activeTool: "map-scraper", viewport: "390x844" },
    },
  });
  assert.equal(fbPost.status, 201);
  assert.ok(!fbPost.json.item.content.includes("test@buyer.mx"));
  assert.ok(!fbPost.json.item.content.includes("8345 6789"));
  assert.ok(!fbPost.json.item.content.includes("secret.mx"));

  const fbPatch = await req(env, "PATCH", `/api/feedback/${fbPost.json.item.id}`, {
    token: bossToken,
    body: { status: "planned", admin_reply: "已纳入 M2-B 优化" },
  });
  assert.equal(fbPatch.status, 200);
  assert.equal(fbPatch.json.item.status, "planned");

  // ===== 9. Per-Device Kick, Employee Disable & Full Backup -> Wipe -> Restore -> Post-Restore Security Verify Drill =====
  // Kick ONLY Alice's Phone (dev1) -> Phone dies immediately, Laptop (dev2) still works!
  const kickOne = await req(env, "POST", `/api/admin/employees/${aliceId}/revoke-sessions`, {
    token: bossToken,
    body: { session_id: aliceDev1.json.sessionId, totp_code: codeNow },
  });
  assert.equal(kickOne.status, 200);
  assert.equal((await req(env, "GET", "/api/auth/me", { token: aliceToken1 })).status, 401);
  assert.equal((await req(env, "GET", "/api/auth/me", { token: aliceToken2 })).status, 200);

  // Disable Alice -> Alice's Laptop dies IMMEDIATELY, Bob unaffected!
  const disAlice = await req(env, "PATCH", `/api/admin/employees/${aliceId}`, {
    token: bossToken,
    body: { status: "disabled", totp_code: codeNow },
  });
  assert.equal(disAlice.status, 200);
  assert.equal((await req(env, "GET", "/api/companies", { token: aliceToken2 })).status, 401);
  assert.equal((await req(env, "GET", "/api/companies", { token: bobToken })).status, 200);

  // Export logical backup snapshot
  const bak = await req(env, "POST", "/api/admin/export-backup", {
    token: bossToken,
    body: { totp_code: codeNow },
  });
  assert.equal(bak.status, 200);
  assert.equal(bak.json.counts.companies, 3);
  assert.ok(bak.json.counts.contact_events >= 4);

  // Wipe all business tables in DB to simulate disaster recovery drill!
  for (const tbl of Object.keys(bak.json.tables)) {
    db.raw.exec(`DELETE FROM ${tbl}`);
  }
  assert.equal((await req(env, "GET", "/api/companies", { token: bossToken })).json.total, 0);

  // Restore from backup snapshot
  const rst = await req(env, "POST", "/api/admin/restore-backup", {
    token: bossToken,
    body: { totp_code: codeNow, confirmPhrase: "RESTORE_CONFIRM", tables: bak.json.tables },
  });
  assert.equal(rst.status, 200);
  assert.equal(rst.json.restoredCounts.companies, 3);

  // Mandatory Post-Restore Security Re-Verification Gate
  const prv = await req(env, "POST", "/api/admin/post-restore-verify", {
    token: bossToken,
    body: { totp_code: codeNow, revokeOtherSessions: true },
  });
  assert.equal(prv.status, 200);
  assert.equal(prv.json.report.activeCompanies, 3);
  assert.equal(prv.json.report.optOutProtectedCount, 1);
  assert.ok(prv.json.report.revokedOtherSessions >= 1);

  // After post-restore verify, Bob's old session was forced to re-login AND disabled Alice stays blocked!
  assert.equal((await req(env, "GET", "/api/companies", { token: bobToken })).status, 401);
  assert.equal((await req(env, "POST", "/api/auth/login", { body: { login_id: "alice", password: "AlicePass123" } })).status, 401);
  const bobRelogin = await req(env, "POST", "/api/auth/login", { body: { login_id: "bob", password: "BobPass1234" } });
  assert.equal(bobRelogin.status, 200);
  assert.equal((await req(env, "GET", "/api/companies", { token: bobRelogin.json.token })).json.total, 3);
});
