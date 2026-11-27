const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const FG_CORE = require("../js/fg-core.js");

const DIAL_MAP = {
  Vietnam: "84",
  Mexico: "52",
  Italy: "39",
  "Saudi Arabia": "966",
  Germany: "49",
  "United States": "1"
};

test("T01 Security Sanitizers: escHtml, extractCleanDomain, safeHttpUrl & safeInit", () => {
  assert.equal(FG_CORE.escHtml('<img src=x onerror="alert(1)">'), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  assert.equal(FG_CORE.extractCleanDomain("https://www.Siemens-Energy.com/en/contact?x=1"), "siemens-energy.com");
  assert.equal(FG_CORE.extractCleanDomain("buyer@saigonvalve.vn"), "saigonvalve.vn");
  assert.equal(FG_CORE.extractCleanDomain('<img src=x onerror="window.__xss=1">'), "");
  assert.equal(FG_CORE.extractCleanDomain("javascript:alert(1)//evil.com"), "");
  assert.equal(FG_CORE.isValidDomain("localhost"), false);
  assert.equal(FG_CORE.isValidDomain("sub.industrial-valve.co.uk"), true);

  assert.equal(FG_CORE.safeHttpUrl("javascript:alert(1)"), "");
  assert.equal(FG_CORE.safeHttpUrl("data:text/html,<script>alert(1)</script>"), "");
  assert.equal(FG_CORE.safeHttpUrl("vbscript:msgbox(1)"), "");
  assert.equal(FG_CORE.safeHttpUrl('https://example.com/"><script>'), "");
  assert.equal(FG_CORE.safeHttpUrl("https://www.worldbank.org/en/projects"), "https://www.worldbank.org/en/projects");

  let secondRan = false;
  FG_CORE.safeInit("BrokenModule", () => { throw new Error("boom"); });
  FG_CORE.safeInit("HealthyModule", () => { secondRan = true; });
  assert.equal(secondRan, true);
});

test("T02/T03 Fixed-Point Math & Conservative Default Tax Mode (Small-Scale Taxpayer)", () => {
  const { DEC } = FG_CORE;
  assert.equal(DEC.formatScaled(DEC.toScaled("0.1") + DEC.toScaled("0.2"), 8), "0.30000000");

  // Default small_exempt mode: ¥100,000 payable, FX 7.0, 20% margin, 13% VAT / 13% hypothetical rebate
  // Base price MUST NOT deduct 13% rebate: $100,000 / 7.0 / 0.8 = $17,857.15 (ceil 2 dec)
  const qCons = FG_CORE.computeQuote({
    priceMode: "total",
    taxMode: "small_exempt",
    rawFac: "100000",
    qty: 1,
    fx: "7.0",
    vatPct: 13,
    rebPct: 13,
    marginPct: 20,
    commPct: 0,
    locRmb: 0,
    freightUsd: 0,
    insPct: 0,
    bankUsd: 0
  });
  assert.equal(qCons.ok, true);
  assert.equal(qCons.pricingRebateRmb, 0);
  assert.ok(qCons.fobUsd >= 17857.14 && qCons.fobUsd <= 17857.16);
  assert.ok(Math.abs(qCons.fobMarginConservativePct - 20.0) < 0.05);
  // Hypothetical post-rebate profit is strictly higher by ~¥11,504.42
  assert.ok(qCons.fobProfitWithRebateRmb > qCons.fobProfitConservativeRmb + 11500);

  // Confirmed General Taxpayer VAT Rebate mode deducts ¥11,504.42 rebate
  const qReb = FG_CORE.computeQuote({
    priceMode: "total",
    taxMode: "vat_rebate",
    rawFac: "100000",
    qty: 1,
    fx: "7.0",
    vatPct: 13,
    rebPct: 13,
    marginPct: 20,
    commPct: 0
  });
  assert.equal(qReb.ok, true);
  assert.ok(Math.abs(qReb.pricingRebateRmb - 11504.42) < 0.02);
  assert.ok(qReb.fobUsd < qCons.fobUsd);

  // Invalid: rebate rate > VAT invoice rate
  const qBadTax = FG_CORE.computeQuote({
    taxMode: "vat_rebate",
    rawFac: "100000",
    qty: 1,
    fx: "7.2",
    vatPct: 6,
    rebPct: 13,
    marginPct: 15
  });
  assert.equal(qBadTax.ok, false);
  assert.ok(qBadTax.errs.some(e => e.includes("不能高于采购发票增值税率")));

  // Ex-tax mode ignores rebate and applies optional invoicing surcharge
  const qEx = FG_CORE.computeQuote({
    taxMode: "ex_tax",
    rawFac: "100000",
    exTaxExtraPct: 8,
    rebPct: 13,
    qty: 1,
    fx: "7.2",
    marginPct: 20
  });
  assert.equal(qEx.ok, true);
  assert.equal(qEx.payableProcRmb, 108000);
  assert.equal(qEx.potentialRebateRmb, 0);
});

test("T02/T03 Fastener Auto Precision & CIF Commission Mode A vs Mode B", () => {
  // Fastener: ¥0.15/pc * 100,000 pcs, FX 7.2, Margin 20%
  const qFast = FG_CORE.computeQuote({
    priceMode: "unit",
    taxMode: "vat_rebate",
    rawFac: "0.15",
    qty: 100000,
    fx: "7.2",
    vatPct: 13,
    rebPct: 13,
    marginPct: 20,
    decimals: "auto"
  });
  assert.equal(qFast.ok, true);
  assert.equal(qFast.decimals, 5); // < $0.10 -> 5 decimals ($0.02305)
  assert.ok(qFast.fobUsd >= 2304.57, `Expected >= 2304.57, got ${qFast.fobUsd}`);
  assert.ok(qFast.fobMarginPct >= 20.0);

  // CIF Commission Mode A (preserve profit amount) vs Mode B (preserve CIF margin %)
  const baseParams = {
    priceMode: "total",
    taxMode: "small_exempt",
    rawFac: "72000", // $10,000 cost at FX 7.2
    qty: 10,
    fx: "7.2",
    marginPct: 20,
    commPct: 5,
    freightUsd: 4000,
    insPct: 0.3
  };
  const modeA = FG_CORE.computeQuote({ ...baseParams, commBasis: "cif_keep_amt" });
  const modeB = FG_CORE.computeQuote({ ...baseParams, commBasis: "cif_keep_pct" });
  const modeFob = FG_CORE.computeQuote({ ...baseParams, commBasis: "fob" });

  assert.equal(modeA.ok && modeB.ok && modeFob.ok, true);
  // Mode A preserves RMB profit amount between FOB and CIF (within ceiling rounding of a few RMB)
  assert.ok(Math.abs(modeA.cifProfitRmb - modeA.fobProfitRmb) < 2.0, `Mode A profit diff too big: ${modeA.cifProfitRmb} vs ${modeA.fobProfitRmb}`);
  assert.ok(modeA.cifCommUsd > modeA.fobCommUsd + 200);
  // Mode B preserves ~20% margin on total CIF value, so CIF price and profit are higher than Mode A
  assert.ok(Math.abs(modeB.cifMarginPct - 20.0) < 0.05);
  assert.ok(modeB.cifUsd > modeA.cifUsd);
  // FOB-only commission keeps cifCommUsd === fobCommUsd
  assert.equal(modeFob.cifCommUsd, modeFob.fobCommUsd);
});

test("T04 Container Load Optimizer: 40GP Long Cargo, 30t Single Unit Hard Block, noStack & noRotate", () => {
  // 1. 6m pipes (600x50x50cm, h=50<=228cm) -> 40'GP allowed!
  const cPipe = FG_CORE.computeContainerLoad(
    [{ name: "6m无缝钢管", l: 600, w: 50, h: 50, kg: 300, qty: 10 }],
    { routeMode: "std", packMode: "crate" }
  );
  assert.equal(cPipe.ok, true);
  assert.ok(cPipe.rec.includes("40'GP"), `Expected 40'GP, got ${cPipe.rec}`);

  // 2. 240cm tall switchgear -> forces 40'HQ
  const cTall = FG_CORE.computeContainerLoad(
    [{ name: "高压开关柜", l: 120, w: 100, h: 240, kg: 600, qty: 4 }],
    { routeMode: "std", packMode: "crate" }
  );
  assert.ok(cTall.rec.includes("40'HQ"));

  // 3. 30t single indivisible machine -> hard-blocks multi-dry-container split!
  const c30t = FG_CORE.computeContainerLoad(
    [{ name: "30t球磨机主机", l: 420, w: 210, h: 210, kg: 30000, qty: 1 }],
    { routeMode: "std", packMode: "crate" }
  );
  assert.equal(c30t.isSingleOverweight, true);
  assert.ok(!c30t.rec.includes("2 × 20'GP") && !c30t.rec.includes("2 × 40'HQ"));
  assert.equal(c30t.summaryEn, "");

  // 4. Non-stackable (noStack): 15 pallets of 100x100x80cm = 12 CBM (would fit 20'GP if stacked, but 15 m^2 > 13 m^2 floor!)
  const cNoStack = FG_CORE.computeContainerLoad(
    [{ name: "精密控制柜", l: 100, w: 100, h: 80, kg: 200, qty: 15, noStack: true }],
    { routeMode: "std", packMode: "crate" }
  );
  assert.ok(cNoStack.rec.includes("40'GP"), `Expected 40'GP due to 15m2 noStack floor, got ${cNoStack.rec}`);

  // 5. Non-rotatable (noRotate): l=200, w=240 (>234cm door width when unable to rotate)
  const cNoRot = FG_CORE.computeContainerLoad(
    [{ name: "不可旋转宽体机架", l: 200, w: 240, h: 180, kg: 1500, qty: 1, noRotate: true }],
    { routeMode: "std", packMode: "crate" }
  );
  assert.equal(cNoRot.isSpecialOog, true);
});

test("T08 Phone Extension Stripping, Italian Landline Zero & Cross-Country CSV Dedupe", () => {
  const mxExt = FG_CORE.analyzePhoneCore("+52 81 8345 6789 ext. 204", "Mexico", DIAL_MAP);
  assert.equal(mxExt.digits, "528183456789");
  assert.equal(mxExt.ext, "204");
  assert.equal(mxExt.waUrl, "https://wa.me/528183456789");

  const itLandline = FG_CORE.analyzePhoneCore("02 12345678", "Italy", DIAL_MAP);
  assert.equal(itLandline.digits, "390212345678");

  const vnMobile = FG_CORE.analyzePhoneCore("0903 899 112", "Vietnam", DIAL_MAP);
  assert.equal(vnMobile.digits, "84903899112");

  const kVn = FG_CORE.buildLeadDedupeKey({ company: "Delta Valve Co.", country: "Vietnam" }, DIAL_MAP);
  const kMx = FG_CORE.buildLeadDedupeKey({ company: "Delta Valve Co.", country: "Mexico" }, DIAL_MAP);
  assert.notEqual(kVn, kMx);
});

test("T05 Lossless Stable-ID CRM Lead Merge (id / tlId / quoteId)", () => {
  const leadA = {
    id: "ld_100",
    company: "Al-Dammam Piping",
    country: "Saudi Arabia",
    phone: "+966138429900",
    updatedAt: "2026-11-26T08:00:00Z",
    timeline: [
      { tlId: "tl_1", ts: "2026-11-26 10:00", txt: "首次电话破冰" },
      { tlId: "tl_2", ts: "2026-11-26 10:00", txt: "同分钟补充技术参数" }
    ],
    quotes: [{ quoteId: "qt_v1", ver: "V1", savedAt: "2026-11-26 10:05", fobStr: "$12,000.00" }]
  };
  const leadB = {
    id: "ld_100",
    company: "Al-Dammam Piping LLC",
    country: "Saudi Arabia",
    phone: "", // Empty in B must NOT wipe out phone from A!
    email: "buyer@gulfpiping.sa",
    updatedAt: "2026-11-26T09:00:00Z",
    timeline: [
      { tlId: "tl_1", ts: "2026-11-26 10:00", editedAt: "2026-11-26T09:00:00Z", txt: "首次电话破冰（已更新采购总监姓名）" },
      { tlId: "tl_3", ts: "2026-11-26 11:00", txt: "发送样本册" }
    ],
    quotes: [{ quoteId: "qt_v2", ver: "V2", savedAt: "2026-11-26 11:10", fobStr: "$11,800.00" }]
  };

  const merged = FG_CORE.mergeLeadRecord(leadA, leadB);
  assert.equal(merged.id, "ld_100");
  assert.equal(merged.company, "Al-Dammam Piping LLC");
  assert.equal(merged.phone, "+966138429900");
  assert.equal(merged.email, "buyer@gulfpiping.sa");
  assert.equal(merged.timeline.length, 3);
  assert.equal(merged.timeline.find(t => t.tlId === "tl_1").txt, "首次电话破冰（已更新采购总监姓名）");
  assert.equal(merged.quotes.length, 2);
});

test("T09 Cloudflare Worker & QuotaLimiter Durable Object Atomic Concurrency, Fail-Closed & Security", async () => {
  const workerUrl = pathToFileURL(path.resolve(__dirname, "../workers/gmaps-proxy.js")).href;
  const workerMod = await import(workerUrl);
  const worker = workerMod.default;
  const { QuotaLimiter } = workerMod;

  // Helper in-memory Durable Object storage + namespace mock
  function createDoNamespace(initialUsed = 0, shouldThrow = false) {
    const store = new Map();
    const ym = new Date().toISOString().slice(0, 7);
    if (initialUsed > 0) store.set(`gmaps_used_${ym}`, initialUsed);
    const state = {
      storage: {
        async get(k) {
          if (shouldThrow) throw new Error("DO storage unavailable");
          await new Promise(r => setTimeout(r, 2)); // Simulate async I/O race window
          return store.get(k);
        },
        async put(k, v) {
          if (shouldThrow) throw new Error("DO storage write failed");
          store.set(k, v);
        }
      }
    };
    const instance = new QuotaLimiter(state, {});
    return {
      store,
      ns: {
        idFromName(name) { return name; },
        get() { return instance; }
      }
    };
  }

  const origFetch = global.fetch;
  let upstreamCalls = 0;
  let forceUpstreamFail = false;
  global.fetch = async (url) => {
    if (String(url).includes("places.googleapis.com")) {
      upstreamCalls++;
      if (forceUpstreamFail) throw new Error("Upstream socket hangup");
      return new Response(JSON.stringify({ places: [{ displayName: { text: "Test Valve Corp" } }] }), { status: 200 });
    }
    throw new Error("Unexpected URL: " + url);
  };

  try {
    const { store, ns } = createDoNamespace(0, false);
    const baseEnv = {
      TEAM_PASS: "fg-secret-2026",
      GOOGLE_MAPS_API_KEY: "AIzaFakeKeyForUnitTest",
      ALLOWED_ORIGIN: "https://jasunmr389-ship-it.github.io",
      QUOTA_LIMITER: ns
    };

    // 1. Unauthorized Origin -> 403 without touching quota or upstream
    const rOrigin = await worker.fetch(new Request("https://proxy.example.com/", {
      method: "POST",
      headers: { Origin: "https://evil.example.com", "X-Team-Pass": "fg-secret-2026", "Content-Type": "application/json" },
      body: JSON.stringify({ textQuery: "valve" })
    }), baseEnv);
    assert.equal(rOrigin.status, 403);
    assert.equal(upstreamCalls, 0);

    // 2. Wrong password -> 401
    const rAuth = await worker.fetch(new Request("https://proxy.example.com/", {
      method: "POST",
      headers: { Origin: "https://jasunmr389-ship-it.github.io", "X-Team-Pass": "wrong", "Content-Type": "application/json" },
      body: JSON.stringify({ textQuery: "valve" })
    }), baseEnv);
    assert.equal(rAuth.status, 401);

    // 3. Invalid JSON / empty textQuery -> 400 BEFORE consuming quota!
    const rBadJson = await worker.fetch(new Request("https://proxy.example.com/", {
      method: "POST",
      headers: { Origin: "https://jasunmr389-ship-it.github.io", "X-Team-Pass": "fg-secret-2026", "Content-Type": "application/json" },
      body: "{bad_json"
    }), baseEnv);
    assert.equal(rBadJson.status, 400);
    assert.equal(store.size, 0);

    // 4. Missing QUOTA_LIMITER without ALLOW_UNMETERED_DEV -> Fail-closed 503!
    const rNoDo = await worker.fetch(new Request("https://proxy.example.com/", {
      method: "POST",
      headers: { Origin: "https://jasunmr389-ship-it.github.io", "X-Team-Pass": "fg-secret-2026", "Content-Type": "application/json" },
      body: JSON.stringify({ textQuery: "valve" })
    }), { ...baseEnv, QUOTA_LIMITER: null });
    assert.equal(rNoDo.status, 503);
    assert.equal(upstreamCalls, 0);

    // 5. Upstream 502 error does NOT refund reserved quota
    forceUpstreamFail = true;
    const r502 = await worker.fetch(new Request("https://proxy.example.com/", {
      method: "POST",
      headers: { Origin: "https://jasunmr389-ship-it.github.io", "X-Team-Pass": "fg-secret-2026", "Content-Type": "application/json" },
      body: JSON.stringify({ textQuery: "valve" })
    }), baseEnv);
    assert.equal(r502.status, 502);
    const body502 = await r502.json();
    assert.equal(body502.quotaUsed, 1);
    forceUpstreamFail = false;

    // 6. High-Concurrency Atomic Test: start at 920, fire 50 simultaneous requests against 950 hard cap
    upstreamCalls = 0;
    const { ns: raceNs } = createDoNamespace(920, false);
    const raceEnv = { ...baseEnv, QUOTA_LIMITER: raceNs };
    const reqs = Array.from({ length: 50 }, (_, i) =>
      worker.fetch(new Request("https://proxy.example.com/", {
        method: "POST",
        headers: { Origin: "https://jasunmr389-ship-it.github.io", "X-Team-Pass": "fg-secret-2026", "Content-Type": "application/json" },
        body: JSON.stringify({ textQuery: "industrial valve " + i })
      }), raceEnv)
    );
    const responses = await Promise.all(reqs);
    const okCount = responses.filter(r => r.status === 200).length;
    const blockedCount = responses.filter(r => r.status === 429).length;
    assert.equal(okCount, 30, `Expected exact 30 allowed (921..950), got ${okCount}`);
    assert.equal(blockedCount, 20, `Expected exact 20 blocked with 429, got ${blockedCount}`);
    assert.equal(upstreamCalls, 30, `Expected exact 30 upstream Google calls, got ${upstreamCalls}`);
    assert.equal(responses.find(r => r.status === 200).headers.get("X-Quota-Mode"), "durable-object");

    // 7. Round 2 P1-8: ENVIRONMENT="production" MUST block ALLOW_UNMETERED_DEV="true" (Fail-Closed 503)
    const rProdBypassBlocked = await worker.fetch(new Request("https://proxy.example.com/", {
      method: "POST",
      headers: { Origin: "https://jasunmr389-ship-it.github.io", "X-Team-Pass": "fg-secret-2026", "Content-Type": "application/json" },
      body: JSON.stringify({ textQuery: "valve" })
    }), { ...baseEnv, QUOTA_LIMITER: null, ALLOW_UNMETERED_DEV: "true", ENVIRONMENT: "production" });
    assert.equal(rProdBypassBlocked.status, 503);
  } finally {
    global.fetch = origFetch;
  }
});

test("Round 2 P1-5 / P1-6 / P1-7 / P0-1: 5x9t FFD Packing, Device-Tagged Ref, Post-Rounding Profit Floor & Soft-Delete Protection", () => {
  // P1-5: 5 indivisible machines x 9,000 kg = 45t on 26t container limit -> 2 per container max (18t <= 26t, 3x9t=27t > 26t) => MUST be 3 containers!
  const c5x9t = FG_CORE.computeContainerLoad(
    [{ name: "9t重型数控立车", l: 220, w: 180, h: 190, kg: 9000, qty: 5, noStack: false, noRotate: false }],
    { routeMode: "std", packMode: "crate" }
  );
  assert.equal(c5x9t.ok, true);
  assert.ok(/^3\s*×/.test(c5x9t.rec), `Expected 3 containers for 5x9t on 26t limit, got: ${c5x9t.rec}`);

  // Mixed FFD: 3 x 15t + 3 x 10t (total 75t) on 26t limit -> FFD pairs (15t + 10t = 25t <= 26t) into 3 containers!
  const cMixedFfd = FG_CORE.computeContainerLoad(
    [
      { name: "10t辅机", l: 150, w: 120, h: 150, kg: 10000, qty: 3 },
      { name: "15t主机", l: 200, w: 150, h: 180, kg: 15000, qty: 3 }
    ],
    { routeMode: "std", packMode: "crate" }
  );
  assert.ok(/^3\s*×/.test(cMixedFfd.rec), `Expected FFD to pair 15t+10t into 3 containers, got: ${cMixedFfd.rec}`);

  // P1-6: Device-tagged Quote Reference format + backward compatibility
  const refWithDev = FG_CORE.formatQuoteRef({ dateStr: "2026-11-26", clientName: "Saigon Valve JSC", deviceTag: "A9F2", seq: 7, version: 2 });
  assert.equal(refWithDev, "FG-20261126-SAIGON-A9F2-007-V2");
  const refLegacy = FG_CORE.formatQuoteRef({ dateStr: "2026-11-26", clientName: "Saigon Valve JSC", seq: 7, version: 2 });
  assert.equal(refLegacy, "FG-20261126-SAIGON-007-V2");

  // P1-7: Post-rounding profit floor guard & conservative 0-rebate negative warning
  const qBelowFloor = FG_CORE.computeQuote({
    priceMode: "unit",
    taxMode: "vat_rebate",
    rawFac: "10000",
    qty: 5,
    fx: "7.2",
    vatPct: 13,
    rebPct: 13,
    marginPct: 6,
    minMarginFloorPct: 10
  });
  assert.equal(qBelowFloor.ok, true);
  assert.equal(qBelowFloor.belowProfitFloor, true);
  assert.equal(qBelowFloor.conservativeNegativeWarn, true); // 6% post-rebate margin with 13% rebate => negative if rebate is denied!
  assert.ok(qBelowFloor.quoteId.startsWith("qt_"));

  // P0-1: Soft-delete protection against stale background tab overwrite + monotonic _rev
  const softDeletedInDb = {
    id: "ld_del_race",
    company: "Deleted Corp",
    country: "Vietnam",
    deletedAt: 1795600099000,
    deletedAtStr: "2026-11-26 17:00",
    deletedBy: "TabA",
    deleteReason: "风控淘汰",
    _rev: 4,
    updatedAt: 1795600099000,
    timeline: [{ tlId: "tl_a", ts: "2026-11-26 16:50", result: "TabA记录" }],
    quotes: []
  };
  const staleActiveFromTabB = {
    id: "ld_del_race",
    company: "Deleted Corp",
    country: "Vietnam",
    deletedAt: null,
    _rev: 3,
    updatedAt: 1795600105000,
    timeline: [{ tlId: "tl_b", ts: "2026-11-26 17:01", result: "TabB并发跟进不丢失" }],
    quotes: []
  };
  const protectedMerge = FG_CORE.mergeLeadRecord(softDeletedInDb, staleActiveFromTabB, { respectExistingSoftDelete: true });
  assert.equal(protectedMerge.deletedAt, 1795600099000, "Soft-deleted lead MUST NOT be resurrected by stale tab");
  assert.equal(protectedMerge.timeline.length, 2, "Concurrent timeline from Tab B still safely preserved in trash record");
  assert.equal(protectedMerge._rev, 5, "Monotonic _rev incremented");
});

test("10. Phase 2A: Accented email guesser, localized product names, GLEIF precision & cadence", () => {
  // P2A-2: Diacritic & special Latin transliteration
  assert.equal(FG_CORE.normalizeEmailToken("José"), "jose");
  assert.equal(FG_CORE.normalizeEmailToken("García"), "garcia");
  assert.equal(FG_CORE.normalizeEmailToken("Đặng"), "dang");
  assert.equal(FG_CORE.normalizeEmailToken("Nguyễn"), "nguyen");
  assert.equal(FG_CORE.normalizeEmailToken("Müller-ß"), "mullerss");
  assert.equal(FG_CORE.normalizeEmailToken("Łukasz"), "lukasz");

  const deEmails = FG_CORE.guessCorporateEmails("Jürgen", "Müller", "valve-tech.de");
  assert.equal(deEmails[0], "juergen.mueller@valve-tech.de");
  assert.ok(deEmails.includes("jurgen.muller@valve-tech.de"));

  const mxEmails = FG_CORE.guessCorporateEmails("José", "García", "https://www.acero-monterrey.com.mx/about");
  assert.equal(mxEmails[0], "jose.garcia@acero-monterrey.com.mx");
  assert.ok(mxEmails.includes("jgarcia@acero-monterrey.com.mx"));

  const vnEmails = FG_CORE.guessCorporateEmails("Đặng", "Nguyễn", "saigonvalve.vn");
  assert.equal(vnEmails[0], "dang.nguyen@saigonvalve.vn");

  // P2A-3: Localized product names across target languages
  assert.equal(
    FG_CORE.localizeProductForLang("industrial valves & water pumps", "es"),
    "válvulas industriales y bombas de agua"
  );
  assert.equal(
    FG_CORE.localizeProductForLang("steel structures", "ar"),
    "الهياكل الفولاذية المسبقة الصنع"
  );
  assert.equal(
    FG_CORE.localizeProductForLang("power cables", "vi"),
    "cáp điện công nghiệp"
  );
  assert.equal(
    FG_CORE.localizeProductForLang("Custom Duplex SS2205 Manifold", "es"),
    "Custom Duplex SS2205 Manifold",
    "Custom specific product names not in generic phrase table remain untouched"
  );

  // P2A-4: GLEIF entity scoring rejects foreign retired pension funds & street-name noise
  assert.equal(FG_CORE.resolveCountryIso2("Germany"), "DE");
  assert.equal(FG_CORE.resolveCountryIso2("Saudi Arabia"), "SA");
  const mockGleif = [
    {
      id: "LEI_CH_RETIRED_PENSION",
      attributes: {
        entity: { legalName: { name: "Pensionskasse der Siemens-Gesellschaften in der Schweiz" }, legalAddress: { country: "CH" }, status: "INACTIVE" },
        registration: { status: "RETIRED" }
      }
    },
    {
      id: "LEI_DE_PENSION_NOISE",
      attributes: {
        entity: { legalName: { name: "Siemens Pensionsfonds AG" }, legalAddress: { country: "DE" }, status: "ACTIVE" },
        registration: { status: "ISSUED" }
      }
    },
    {
      id: "LEI_DE_STREET_NOISE",
      attributes: {
        entity: { legalName: { name: "INTEC AG" }, legalAddress: { country: "DE" }, status: "ACTIVE" },
        registration: { status: "ISSUED" }
      }
    },
    {
      id: "5299005CHJZ14D4FDJ62",
      attributes: {
        entity: { legalName: { name: "Siemens Energy AG" }, legalAddress: { country: "DE" }, status: "ACTIVE" },
        registration: { status: "ISSUED" }
      }
    }
  ];
  const rankedDe = FG_CORE.scoreGleifRecords(mockGleif, "Siemens AG", "Germany");
  assert.equal(rankedDe.length, 1);
  assert.equal(rankedDe[0].id, "5299005CHJZ14D4FDJ62");
  assert.equal(rankedDe[0].countryIso2, "DE");

  // P2A-5: Default +3d follow-up (shifting Sunday -> Monday) & 21-day cadence schedule
  // 2026-11-26 is Thursday -> +3 days is Sunday 2026-11-29 -> auto-shifts to Monday 2026-11-30!
  assert.equal(FG_CORE.computeDefaultNextFollowDate("2026-11-26", 3), "2026-11-30");
  // 2026-11-25 is Wednesday -> +3 days is Saturday 2026-11-28
  assert.equal(FG_CORE.computeDefaultNextFollowDate("2026-11-25", 3), "2026-11-28");

  const c1 = FG_CORE.nextCadenceSchedule("first", "2026-11-26");
  assert.equal(c1.nextStep, "followup");
  assert.equal(c1.nextDate, "2026-11-30");
  const c2 = FG_CORE.nextCadenceSchedule("followup", "2026-11-30");
  assert.equal(c2.nextStep, "case");
  assert.equal(c2.nextDate, "2026-12-04");
});

test("11. Phase 2B: Product profiles, signal icebreakers, LinkedIn <=280-char cap, ICP dorks, A/B/C inquiry triage & weekly funnel", () => {
  // P2B-1: Product profiles
  const profSteel = FG_CORE.getProductProfile("steel_fastener");
  assert.equal(profSteel.key, "steel_fastener");
  assert.ok(profSteel.lfCustom.includes("prefabricated steel structure"));
  assert.equal(FG_CORE.getProductProfile("nonexistent_key").key, "all");

  // P2B-2: Signal icebreakers + LinkedIn <=280 char hard cap even with very long names
  const sigImpEs = FG_CORE.buildSignalIcebreaker("import", {
    comp: "Aceros del Norte SA",
    country: "Mexico",
    prod: "estructuras de acero",
    signalNote: "HS 7308 · 14票提单"
  }, "es");
  assert.ok(sigImpEs.includes("importa regularmente"));
  assert.ok(sigImpEs.includes("HS 7308"));

  const liLong = FG_CORE.buildLinkedInOutreach("linkedin_conn", {
    contact: "Maximiliano Alejandro Fernández-Villalobos",
    comp: "Corporación Internacional de Ingeniería, Construcción Pesada y Suministros Petroleros de Latinoamérica S.A. de C.V.",
    country: "Mexico",
    prod: "heavy-duty forged high-pressure trunnion mounted API 6D pipeline ball valves and centrifugal slurry pumps",
    sender: "FriesGo Global Industrial Supply Team"
  }, "en");
  assert.equal(liLong.withinLimit, true);
  assert.ok(liLong.charCount <= 280, `Expected LinkedIn connection note <= 280 chars, got ${liLong.charCount}`);

  const liDm = FG_CORE.buildLinkedInOutreach("linkedin_dm", {
    contact: "Carlos",
    comp: "Monterrey Steel",
    prod: "estructuras de acero"
  }, "es");
  assert.ok(liDm.text.includes("Gracias por aceptar"));

  // LinkedIn cadence progression
  const cLi1 = FG_CORE.nextCadenceSchedule("linkedin_conn", "2026-11-26");
  assert.equal(cLi1.nextStep, "linkedin_dm");
  assert.equal(cLi1.nextDate, "2026-11-30"); // Sunday shifted to Monday

  // P2B-3a: ICP Buyer Role Dorks
  const dorksEpc = FG_CORE.buildBuyerRoleDorks("Saudi Arabia", "power cable OR switchgear", "epc_eng");
  assert.ok(dorksEpc.rawQuery.includes("site:linkedin.com/in/"));
  assert.ok(dorksEpc.rawQuery.includes("EPC Manager"));
  assert.ok(dorksEpc.linkedinPeopleUrl.startsWith("https://www.google.com/search?q="));

  // P2B-3b: A / B / C Inquiry Triage & Clarification Generator
  const inqA = FG_CORE.buildInquiryClarification({ company: "Gulf EPC", missingItems: [] });
  assert.equal(inqA.tier, "A");
  const inqB = FG_CORE.buildInquiryClarification({ company: "Gulf EPC", missingItems: ["spec", "incoterm"] });
  assert.equal(inqB.tier, "B");
  assert.equal(inqB.missingCount, 2);
  const inqC = FG_CORE.buildInquiryClarification({ company: "Mex Buyer", missingItems: ["spec", "qty", "incoterm", "cert"], lang: "es" });
  assert.equal(inqC.tier, "C");
  assert.ok(inqC.text.includes("Especificación técnica"));

  // P2B-3c: Multi-person decision chain lossless merge + lossReason preservation
  const tab1 = {
    id: "ld_chain_1",
    company: "Andes Mining Corp",
    country: "Chile",
    lossReason: "交期无法满足",
    inquiryTier: "B",
    updatedAt: 1795600100000,
    contacts: [{ ctId: "ct_1", name: "Diego", role: "采购负责人", email: "diego@andesmining.cl" }]
  };
  const tab2 = {
    id: "ld_chain_1",
    company: "Andes Mining Corp",
    country: "Chile",
    lossReason: "",
    inquiryTier: "",
    updatedAt: 1795600200000,
    contacts: [{ ctId: "ct_2", name: "Valeria", role: "工程/技术总工", email: "valeria@andesmining.cl" }]
  };
  const mergedChain = FG_CORE.mergeLeadRecord(tab1, tab2);
  assert.equal(mergedChain.contacts.length, 2, "Distinct contacts from concurrent tabs must union losslessly");
  assert.equal(mergedChain.lossReason, "交期无法满足", "Non-empty lossReason must not be wiped by blank scalar");
  assert.equal(mergedChain.inquiryTier, "B", "Non-empty inquiryTier must not be wiped by blank scalar");

  // P2B-4: Local Weekly Funnel & Loss Attribution
  const funnel = FG_CORE.computeWeeklyFunnel([
    {
      id: "f1",
      company: "Active Quoted Approved",
      stage: "样品/谈判推进",
      updatedAt: "2026-11-25T10:00:00Z",
      ddRecord: { decision: "approved" },
      quotes: [{ quoteId: "q1", refNo: "FG-1" }],
      timeline: [{ tlId: "t1", ts: "2026-11-25 10:00", result: "Sent V1" }]
    },
    {
      id: "f2",
      company: "Lost Price",
      stage: "暂停/流失归档",
      lossReason: "价格高于目标价",
      updatedAt: "2026-11-10T10:00:00Z",
      timeline: []
    },
    {
      id: "f3",
      company: "Soft Deleted Ignored",
      stage: "重点跟进",
      deletedAt: 1795600000000
    }
  ], "2026-11-26");
  assert.equal(funnel.totalActive, 2);
  assert.equal(funnel.touched7d, 1);
  assert.equal(funnel.ddApproved, 1);
  assert.equal(funnel.quotedCount, 1);
  assert.equal(funnel.highIntentOrWon, 1);
  assert.equal(funnel.lostCount, 1);
  assert.equal(funnel.topLossReasons[0].reason, "价格高于目标价");
  assert.equal(funnel.topLossReasons[0].count, 1);
});

test("V2.0: Foreign-Trade Working Hours, Islamic Fri-Sat / Ramadan / Eid Skipping, 60Hz Guardrail, Spam Check & Smart Paste", () => {
  // 1. Saudi Arabia (Sun-Thu) vs Germany (Mon-Fri) weekend skipping in computeDefaultNextFollowDate & nextCadenceSchedule
  // 2026-11-24 is Tuesday -> +3d = 2026-11-27 (Friday!)
  // For Saudi Arabia, Friday & Saturday are weekends -> MUST land on Sunday 2026-11-29!
  assert.equal(FG_CORE.isCountryNonWorkingDate("Saudi Arabia", "2026-11-27"), true);
  assert.equal(FG_CORE.isCountryNonWorkingDate("Saudi Arabia", "2026-11-28"), true);
  assert.equal(FG_CORE.isCountryNonWorkingDate("Saudi Arabia", "2026-11-29"), false);
  assert.equal(FG_CORE.computeDefaultNextFollowDate("2026-11-24", 3, "Saudi Arabia"), "2026-11-29");
  assert.equal(FG_CORE.nextCadenceSchedule("first", "2026-11-24", "Saudi Arabia").nextDate, "2026-11-29");

  // For Germany (Mon-Fri), 2026-11-24 + 3d = Friday 2026-11-27 (working day); 2026-11-25 + 3d = Saturday 2026-11-28 -> Monday 2026-11-30!
  assert.equal(FG_CORE.computeDefaultNextFollowDate("2026-11-24", 3, "Germany"), "2026-11-27");
  assert.equal(FG_CORE.computeDefaultNextFollowDate("2026-11-25", 3, "Germany"), "2026-11-30");

  // Legacy backward-compatibility when countryEn omitted: shifts Sunday -> Monday
  assert.equal(FG_CORE.computeDefaultNextFollowDate("2026-11-26", 3), "2026-11-30");

  // Eid al-Fitr shutdown skipping: 2027-03-09..2027-03-14 is Eid al-Fitr -> Saudi Arabia skips right through to Monday 2027-03-15!
  assert.equal(FG_CORE.computeDefaultNextFollowDate("2027-03-07", 3, "Saudi Arabia"), "2027-03-15");

  // 2. Real-time contact timing across Ramadan, Jummah Friday prayer, Midnight, and Working Hours
  // Ramadan in Riyadh: 2027-02-15 07:30 UTC = 10:30 Riyadh (Monday during Ramadan 10:00-15:00 window) -> yellow Ramadan mode!
  const tmRamadan = FG_CORE.evaluateCountryContactTiming("Saudi Arabia", new Date("2027-02-15T07:30:00Z"));
  assert.equal(tmRamadan.level, "yellow");
  assert.equal(tmRamadan.isRamadan, true);
  assert.ok(tmRamadan.statusLabel.includes("斋月"), `Expected Ramadan label, got: ${tmRamadan.statusLabel}`);

  // UAE Jummah Friday prayer: 2026-11-27 09:00 UTC = 13:00 Dubai (Friday!) -> yellow Jummah warning
  const tmJummah = FG_CORE.evaluateCountryContactTiming("United Arab Emirates", new Date("2026-11-27T09:00:00Z"));
  assert.equal(tmJummah.level, "yellow");
  assert.ok(tmJummah.statusLabel.includes("主麻"), `Expected Jummah label, got: ${tmJummah.statusLabel}`);

  // Mexico midnight: 2026-11-26 08:00 UTC = 02:00 Monterrey CST -> red with exact Beijing send-later calculation!
  const tmMxNight = FG_CORE.evaluateCountryContactTiming("Mexico", new Date("2026-11-26T08:00:00Z"));
  assert.equal(tmMxNight.level, "red");
  assert.ok(tmMxNight.actionAdvice.includes("北京时间"), `Expected Beijing schedule advice, got: ${tmMxNight.actionAdvice}`);
  assert.equal(tmMxNight.spec.is60Hz, true, "Mexico MUST trigger 60Hz motor/pump engineering alert!");

  // Vietnam golden working hours: 2026-11-26 03:00 UTC = 10:00 Ho Chi Minh -> green & 50Hz
  const tmVnWork = FG_CORE.evaluateCountryContactTiming("Vietnam", new Date("2026-11-26T03:00:00Z"));
  assert.equal(tmVnWork.level, "green");
  assert.equal(tmVnWork.spec.is60Hz, false);

  // 3. 60Hz Industrial Guardrails across key countries
  for (const c60 of ["Saudi Arabia", "United States", "Canada", "Mexico", "Brazil", "Peru", "Colombia", "Philippines", "South Korea"]) {
    assert.equal(FG_CORE.getCountryTradeProfile(c60).is60Hz, true, `${c60} must be flagged as 60Hz`);
  }
  for (const c50 of ["Germany", "Vietnam", "Indonesia", "United Arab Emirates", "South Africa", "Australia", "Chile", "Argentina"]) {
    assert.equal(FG_CORE.getCountryTradeProfile(c50).is60Hz, false, `${c50} must be 50Hz`);
  }

  // 4. Global 60-day Dual-Track Alerts (Shutdowns + Pre-Stocking)
  const alerts = FG_CORE.getUpcomingGlobalTradeAlerts("2026-11-27", 75);
  assert.ok(alerts.activeOrSoon.length >= 1, "Should detect SA Builders' Holiday within 20 days of Nov 27");
  assert.ok(alerts.preStocking.some(x => x.group === "cn_factory"), "Should detect China Spring Festival factory cutoff");

  // 5. Cold-Email Spam / Deliverability Checker
  const badSpam = FG_CORE.auditColdEmailDeliverability(
    "100% FREE SAMPLE!!! LOWEST PRICE",
    "Dear Sir/Madam, CLICK HERE to buy now at lowest price 100% free guarantee! https://a.com https://b.com https://c.com"
  );
  assert.equal(badSpam.level, "red");
  assert.ok(badSpam.score < 55);
  assert.ok(badSpam.issues.length >= 3);

  const cleanB2B = FG_CORE.auditColdEmailDeliverability(
    "Sub-supply support for Acero Monterrey – API 6D Ball Valves",
    "Dear Carlos,\n\nWe supply API 6D / ANSI B16.5 ball valves from our ISO 9001 facility in China with full MTC EN 10204 3.1.\n\nMay I send our 1-page spec sheet and FOB Qingdao / CIF Manzanillo quote?\n\nBest regards,\nJasun"
  );
  assert.equal(cleanB2B.level, "green");
  assert.ok(cleanB2B.score >= 85);

  // 6. Smart Business Card / Email Signature Parser
  const parsedCard = FG_CORE.parseSmartBusinessCard(
    "Best regards,\nIng. Carlos Mendez\nPurchasing Manager\nAcero Monterrey S.A. de C.V.\nEmail: cmendez@acero.mx\nWhatsApp / Tel: +52 81 8345 6789\nWeb: https://www.acero.mx"
  );
  assert.equal(parsedCard.email, "cmendez@acero.mx");
  assert.equal(parsedCard.website, "acero.mx");
  assert.equal(parsedCard.country, "Mexico");
  assert.equal(parsedCard.company, "Acero Monterrey S.A. de C.V.");
  assert.ok(parsedCard.contact.includes("Carlos Mendez"), `Expected contact Carlos Mendez, got: ${parsedCard.contact}`);
  assert.ok(parsedCard.phone.includes("+52"), `Expected +52 phone, got: ${parsedCard.phone}`);
});
