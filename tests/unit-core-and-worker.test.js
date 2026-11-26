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

