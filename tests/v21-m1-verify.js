#!/usr/bin/env node
/**
 * V2.1 M1 Full End-to-End Automated Verification (Desktop 1440px + Mobile 390px)
 * Covers all 7 M1 deliverables:
 *  1. P0 Google Places compliance isolation + 7 data accuracy fixes
 *  2. Dual-engine OSM upgrade (true 30km/60km radius, 7s timeout, Photon honest degradation, OSM load-more)
 *  3. 48-country multi-city quick switch + Chinese city resolution + buyer type selector
 *  4. Mobile (<=768px) vertical customer card stream with 0px horizontal overflow
 *  5. WeChat deep link (?radar=<valid_id> highlight + ?radar=<expired_id> notice)
 *  6. Lightweight sanitized Feedback Modal (open, PII scrub, copy, local save, Escape close)
 *  7. Efficiency quick wins (personal quote defaults with >=8% floor guard + 1-click weekly brief)
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = decodeURIComponent(req.url.split("?")[0]);
      const fp = path.join(ROOT, u === "/" ? "/index.html" : u);
      if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
        res.writeHead(404);
        res.end("404");
        return;
      }
      const mimes = {
        ".html": "text/html;charset=utf-8",
        ".js": "application/javascript;charset=utf-8",
        ".json": "application/json;charset=utf-8",
        ".css": "text/css;charset=utf-8",
        ".svg": "image/svg+xml"
      };
      res.writeHead(200, { "Content-Type": mimes[path.extname(fp)] || "text/plain" });
      res.end(fs.readFileSync(fp));
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}

function fetchJson(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => {
      let d = "";
      r.on("data", (c) => (d += c));
      r.on("end", () => {
        try { res(JSON.parse(d)); } catch (e) { rej(e); }
      });
    }).on("error", rej);
  });
}

async function connectCdpTarget(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let seq = 0;
  const pend = new Map();
  const pageErrors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id);
      pend.delete(m.id);
      if (m.error) rej(new Error(m.error.message || JSON.stringify(m.error)));
      else res(m.result);
    } else if (m.method === "Runtime.exceptionThrown") {
      const det = m.params && m.params.exceptionDetails;
      pageErrors.push(det ? (det.text + " " + ((det.exception && det.exception.description) || "")) : "exceptionThrown");
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      pend.set(++seq, { res, rej });
      ws.send(JSON.stringify({ id: seq, method, params }));
    });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const evalJs = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (r && r.exceptionDetails) {
      throw new Error("Eval exception: " + JSON.stringify(r.exceptionDetails));
    }
    return r && r.result ? r.result.value : undefined;
  };
  const navigate = async (url) => {
    await send("Page.navigate", { url });
    await new Promise((r) => setTimeout(r, 900));
  };
  return { ws, send, evalJs, navigate, pageErrors };
}

(async () => {
  const { srv, port } = await startServer();
  const baseUrl = `http://127.0.0.1:${port}/`;
  const userDataDir = `/tmp/fg-v21-m1-verify-${Date.now()}`;
  const dbgPort = 9340 + Math.floor(Math.random() * 400);
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      `--remote-debugging-port=${dbgPort}`,
      `--user-data-dir=${userDataDir}`,
      baseUrl
    ],
    { stdio: "ignore" }
  );

  let cdp = null;
  try {
    let target = null;
    for (let i = 0; i < 40; i++) {
      try {
        const list = await fetchJson(`http://127.0.0.1:${dbgPort}/json/list`);
        target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
        if (target) break;
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(target, "Headless Chrome CDP target did not start");
    cdp = await connectCdpTarget(target.webSocketDebuggerUrl);
    await new Promise((r) => setTimeout(r, 900));

    // Read real radar feed ID for deep-link test
    const radarFeed = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "radar_feed.json"), "utf8"));
    const firstItemId = radarFeed.items[0].id;
    const lateItemId = radarFeed.items[Math.min(15, radarFeed.items.length - 1)].id;

    // ===== 1. Static Data Accuracy Fixes & Verified Macro Footer =====
    const accuracyCheck = await cdp.evalJs(`(() => {
      const chile = document.getElementById("act-Chile").textContent;
      const nigeria = document.getElementById("act-Nigeria").textContent;
      const footer = document.querySelector("footer").textContent;
      const csvNote = document.getElementById("csvVerifyBoundaryNote").textContent;
      const egNote = document.getElementById("egVerifyBoundaryNote").textContent;
      const qcSpec = document.getElementById("qcSpecGuardBar").textContent;
      return { chile, nigeria, footer, csvNote, egNote, qcSpec };
    })()`);
    assert.ok(!accuracyCheck.chile.includes("98% 免税"), "Chile card must not claim blanket 98% duty-free");
    assert.ok(accuracyCheck.chile.includes("排除清单") && accuracyCheck.chile.includes("具体 HS"), "Chile card must mention HS & exclusion list");
    assert.ok(accuracyCheck.nigeria.includes("管制清单") && accuracyCheck.nigeria.includes("豁免"), "Nigeria card must mention SON regulated list & exemptions");
    assert.ok(accuracyCheck.footer.includes("146 国") && accuracyCheck.footer.includes("117 国 2025") && accuracyCheck.footer.includes("29 国 2024*") && accuracyCheck.footer.includes("120 国工业净口径") && accuracyCheck.footer.includes("143 国钢材钢构") && accuracyCheck.footer.includes("76 国 2026 月度 YTD"), "Footer must have exact verified dataset counts");
    assert.ok(accuracyCheck.csvNote.includes("猜邮箱") && accuracyCheck.csvNote.includes("域名可收信") && accuracyCheck.egNote.includes("格式推测候选"), "3-tier email/MX/phone verification boundaries must be visible");
    assert.ok(accuracyCheck.qcSpec.includes("目的国通用参考"), "Quote spec guard bar must include reference applicability disclaimer");
    console.log("PASS 1: Data accuracy wording, 3-tier verification notes, voltage reference disclaimer & exact footer counts");

    // ===== 2. Home KPI Honest Loading / Error / Cached / Empty States & 1-Click Weekly Brief =====
    const kpiStates = await cdp.evalJs(`(() => {
      const origItems = window._liveRadarItems;
      window._setRadarFeedData({ items: [] }, "loading");
      const sLoad = { v: document.getElementById("homeKpiRadar").textContent.trim(), sub: document.getElementById("homeKpiRadarSub").textContent };
      window._setRadarFeedData({ items: [] }, "error");
      const sErr = { v: document.getElementById("homeKpiRadar").textContent.trim(), sub: document.getElementById("homeKpiRadarSub").textContent };
      window._setRadarFeedData({ items: [] }, "empty");
      const sEmpty = { v: document.getElementById("homeKpiRadar").textContent.trim(), sub: document.getElementById("homeKpiRadarSub").textContent };
      window._setRadarFeedData(window.RADAR_FEED_INLINE, "cached_warn");
      const sCache = { v: document.getElementById("homeKpiRadar").textContent.trim(), sub: document.getElementById("homeKpiRadarSub").textContent };
      window._setRadarFeedData(window.RADAR_FEED_INLINE, "ok");
      const sOk = { v: document.getElementById("homeKpiRadar").textContent.trim(), sub: document.getElementById("homeKpiRadarSub").textContent };
      document.getElementById("btnCopyWeeklyBrief").click();
      return { sLoad, sErr, sEmpty, sCache, sOk, brief: window._lastWeeklyBriefText || "" };
    })()`);
    assert.equal(kpiStates.sLoad.v, "…");
    assert.ok(kpiStates.sLoad.sub.includes("加载"));
    assert.equal(kpiStates.sErr.v, "—");
    assert.ok(kpiStates.sErr.sub.includes("异常"));
    assert.equal(kpiStates.sEmpty.v, "0");
    assert.ok(kpiStates.sEmpty.sub.includes("暂无有效商机"));
    assert.ok(kpiStates.sCache.sub.includes("沿用缓存"));
    assert.ok(parseInt(kpiStates.sOk.v, 10) > 0);
    assert.ok(kpiStates.brief.includes("个人本周外贸跟进简报") && kpiStates.brief.includes("在库活跃客户"));
    console.log("PASS 2: Home KPI honest loading/error/cached/empty/ok states + 1-click weekly brief");

    // ===== 3. FX Offline Fallback Date & Quote Source Tag + Personal Quote Defaults =====
    const fxAndQuote = await cdp.evalJs(`(async () => {
      navigateTo("quote-calc");
      // Mock FX offline failure & refresh
      const realFetch = window.fetch;
      localStorage.removeItem("friesgo_fx_cache");
      window.fetch = () => Promise.reject(new Error("offline"));
      document.getElementById("btnRefreshFx").click();
      await new Promise(r => setTimeout(r, 250));
      const fxBadgeOffline = document.getElementById("fxStatusBadge").textContent;
      const fxTag = document.getElementById("qcFxSourceTag").textContent;
      window.fetch = realFetch;

      // Test personal quote defaults with floor clamping (<8% must clamp to 8%)
      document.getElementById("qcLocalRmb").value = "4200";
      document.getElementById("qcPort").value = "Qingdao";
      document.getElementById("qcMinMarginFloor").value = "3";
      document.getElementById("btnSaveQuoteDefaults").click();
      const clampedVal = document.getElementById("qcMinMarginFloor").value;
      const savedRaw = JSON.parse(localStorage.getItem("friesgo_quote_defaults_v1") || "{}");
      return { fxBadgeOffline, fxTag, clampedVal, savedRaw };
    })()`);
    assert.ok(fxAndQuote.fxBadgeOffline.includes("2026-11 内置离线参考基准"), `Unexpected offline badge: ${fxAndQuote.fxBadgeOffline}`);
    assert.ok(fxAndQuote.fxTag.length > 0, "Quote FX source tag must be populated");
    assert.equal(fxAndQuote.clampedVal, "8", "Personal quote default must clamp profit floor >= 8%");
    assert.equal(fxAndQuote.savedRaw.qcLocalRmb, "4200");
    assert.equal(fxAndQuote.savedRaw.qcPort, "Qingdao");

    // Reload page and verify defaults persist, then reset
    await cdp.navigate(baseUrl + "#quote-calc");
    const reloadDefaults = await cdp.evalJs(`(() => {
      const localAfter = document.getElementById("qcLocalRmb").value;
      const portAfter = document.getElementById("qcPort").value;
      const floorAfter = document.getElementById("qcMinMarginFloor").value;
      document.getElementById("btnResetQuoteDefaults").click();
      return {
        localAfter, portAfter, floorAfter,
        localReset: document.getElementById("qcLocalRmb").value,
        portReset: document.getElementById("qcPort").value
      };
    })()`);
    assert.equal(reloadDefaults.localAfter, "4200");
    assert.equal(reloadDefaults.portAfter, "Qingdao");
    assert.equal(reloadDefaults.floorAfter, "8");
    assert.equal(reloadDefaults.localReset, "3500");
    assert.equal(reloadDefaults.portReset, "Ningbo / Shanghai");
    console.log("PASS 3: FX 2026-11 offline date, quote FX source pill & personal quote defaults persist/reset with >=8% floor");

    // ===== 4. Map Multi-City Switch, Chinese City Resolution, True 60km Radius, Photon Degradation, OSM Load More =====
    const osmTest = await cdp.evalJs(`(async () => {
      navigateTo("map-scraper");
      const cSel = document.getElementById("msCountry");
      cSel.value = "Saudi Arabia";
      cSel.dispatchEvent(new Event("change"));
      const saChips = Array.from(document.querySelectorAll("#msCityChips .ms-city-chip")).map(b => b.getAttribute("data-ms-city"));
      // Type Chinese city name "吉达" + buyer type "epc" + radius 60000
      document.getElementById("msCity").value = "吉达";
      document.getElementById("msBuyerType").value = "epc";
      document.getElementById("msRadius").value = "60000";

      const captured = { geoUrls: [], overpassBodies: [], photonUrls: [] };
      const realFetch = window.fetch;
      window.fetch = (url, opts) => {
        const u = String(url);
        if (u.includes("photon.komoot.io/api/?limit=1")) {
          captured.geoUrls.push(u);
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ features: [{ geometry: { coordinates: [39.1925, 21.4858] } }] }) });
        }
        if (u.includes("overpass-api.de")) {
          captured.overpassBodies.push(decodeURIComponent(String((opts && opts.body) || "")));
          // Simulate Overpass timeout/error to test honest degradation to Photon
          return Promise.reject(new Error("simulated_overpass_timeout"));
        }
        if (u.includes("photon.komoot.io/api/?limit=25")) {
          captured.photonUrls.push(u);
          const isRound2 = captured.photonUrls.length > 6;
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              features: isRound2
                ? [{ geometry: { coordinates: [39.21, 21.50] }, properties: { name: "Red Sea Valve Engineering Co.", osm_key: "industrial", osm_value: "engineering", city: "Jeddah" } }]
                : [{ geometry: { coordinates: [39.19, 21.48] }, properties: { name: "Jeddah Piping & Steel Works", osm_key: "man_made", osm_value: "works", city: "Jeddah" } }]
            })
          });
        }
        return realFetch(url, opts);
      };

      window._resetOsmThrottle();
      document.getElementById("btnRunMapScrape").click();
      await new Promise(r => setTimeout(r, 450));
      const status1 = document.getElementById("msStatus").textContent;
      const exportVisibleOsm = !document.getElementById("btnExportMapCsv").hidden;
      const pushVisibleOsm = !document.getElementById("btnPushToCsv").hidden;
      const osmMoreVisible = !document.getElementById("btnOsmMore").hidden;
      const count1 = document.querySelectorAll("#msResultWrap .ms-card").length;

      // Click "继续搜索更多"
      document.getElementById("btnOsmMore").click();
      await new Promise(r => setTimeout(r, 450));
      const status2 = document.getElementById("msStatus").textContent;
      const count2 = document.querySelectorAll("#msResultWrap .ms-card").length;
      const resultHtmlOsm = document.getElementById("msResultWrap").innerHTML;

      window.fetch = realFetch;
      return { saChips, captured, status1, exportVisibleOsm, pushVisibleOsm, osmMoreVisible, count1, status2, count2, resultHtmlOsm };
    })()`);
    assert.ok(osmTest.saChips.includes("Dammam") && osmTest.saChips.includes("Riyadh") && osmTest.saChips.includes("Jeddah"), "Saudi Arabia multi-city chips must include Dammam/Riyadh/Jeddah");
    assert.ok(osmTest.captured.geoUrls[0].includes("Jeddah"), `Chinese city 吉达 must resolve to Jeddah, got: ${osmTest.captured.geoUrls[0]}`);
    // Verify Overpass BBOX spans ~60km (dLat ~= 60000/111320 = 0.5390 deg => full span ~1.08 deg, NOT 18km clamp 0.32 deg!)
    const bbMatch = osmTest.captured.overpassBodies[0].match(/\[bbox:([0-9.-]+),([0-9.-]+),([0-9.-]+),([0-9.-]+)\]/);
    assert.ok(bbMatch, "Overpass query must include bbox");
    const latSpan = parseFloat(bbMatch[3]) - parseFloat(bbMatch[1]);
    assert.ok(latSpan > 0.9, `Expected true 60km bbox latSpan > 0.9 deg (no 18km clamp), got ${latSpan.toFixed(3)}`);
    assert.ok(osmTest.captured.overpassBodies[0].includes("[timeout:7]"), "Overpass timeout must be raised to 7s");
    assert.ok(osmTest.status1.includes("退化") && osmTest.status1.includes("部分结果") && osmTest.status1.includes("60 km"), `Expected honest degradation status, got: ${osmTest.status1}`);
    assert.equal(osmTest.exportVisibleOsm, true);
    assert.equal(osmTest.pushVisibleOsm, true);
    assert.equal(osmTest.osmMoreVisible, true);
    assert.equal(osmTest.count1, 1);
    assert.equal(osmTest.count2, 2, "OSM Load More must append new deduplicated company");
    assert.ok(osmTest.status2.includes("新增 1 家") && osmTest.status2.includes("累计 2 家"));
    assert.ok(osmTest.resultHtmlOsm.includes("OpenStreetMap contributors"), "OSM ODbL attribution must be shown");
    console.log("PASS 4: 48-country chips, CN city resolve (吉达->Jeddah), true 60km radius, 7s timeout, Photon degradation & OSM Load More");

    // ===== 5. Strict Google Places Compliance Isolation (Desktop + Mobile 390px) =====
    const gmapsCheck = await cdp.evalJs(`(async () => {
      document.querySelector('#msEnginePills button[data-ms-eng="gmaps"]').click();
      document.getElementById("msProxyUrl").value = "https://mock-proxy.example.workers.dev";
      document.getElementById("msProxyPass").value = "test-pass";
      const realFetch = window.fetch;
      window.fetch = (url, opts) => {
        if (String(url).includes("mock-proxy.example.workers.dev")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({
              quotaUsed: 12,
              quotaCap: 950,
              places: [
                {
                  id: "ChIJ_MockPlaceId_001",
                  displayName: { text: "Gulf Valves & Industrial LLC" },
                  formattedAddress: "Industrial Area 2, Dammam, Saudi Arabia",
                  internationalPhoneNumber: "+966 13 555 0101",
                  websiteUri: "https://gulfvalves-example.sa",
                  googleMapsUri: "https://maps.google.com/?cid=12345",
                  primaryTypeDisplayName: { text: "Industrial equipment supplier" }
                }
              ]
            })
          });
        }
        return realFetch(url, opts);
      };
      document.getElementById("btnRunMapScrape").click();
      await new Promise(r => setTimeout(r, 350));
      window.fetch = realFetch;

      const exportHidden = document.getElementById("btnExportMapCsv").hidden;
      const pushHidden = document.getElementById("btnPushToCsv").hidden;
      const termsVisible = !document.getElementById("gmapsTermsBanner").hidden;
      const oneClickCrmBtns = document.querySelectorAll("#msResultWrap button[data-map-crm]").length;
      const manualCrmBtns = document.querySelectorAll("#msResultWrap button[data-map-manual-crm]").length;

      // Click "核实后手填建档" and assert ZERO Google fields were copied into #crmAddBox!
      document.querySelector("#msResultWrap button[data-map-manual-crm]").click();
      const addBoxVisible = !document.getElementById("crmAddBox").hidden;
      const copiedCompany = document.getElementById("crmNewComp").value;
      const copiedContact = document.getElementById("crmNewContact").value;
      const copiedProd = document.getElementById("crmNewProd").value;
      const copiedSmart = document.getElementById("crmSmartPasteInp").value;
      return { exportHidden, pushHidden, termsVisible, oneClickCrmBtns, manualCrmBtns, addBoxVisible, copiedCompany, copiedContact, copiedProd, copiedSmart };
    })()`);
    assert.equal(gmapsCheck.exportHidden, true, "Google results MUST hide CSV export");
    assert.equal(gmapsCheck.pushHidden, true, "Google results MUST hide Push-to-CSV");
    assert.equal(gmapsCheck.termsVisible, true, "Google compliance terms banner MUST be shown");
    assert.equal(gmapsCheck.oneClickCrmBtns, 0, "Google results MUST NOT render 1-click CRM copy buttons");
    assert.ok(gmapsCheck.manualCrmBtns >= 2, "Desktop & mobile views must offer manual CRM entry");
    assert.equal(gmapsCheck.addBoxVisible, true, "Manual CRM entry must open #crmAddBox");
    assert.equal(gmapsCheck.copiedCompany, "", "Zero Google company copied into CRM");
    assert.equal(gmapsCheck.copiedContact, "", "Zero Google contact/phone copied into CRM");
    assert.equal(gmapsCheck.copiedProd, "", "Zero Google product copied into CRM");
    assert.equal(gmapsCheck.copiedSmart, "", "Zero Google text copied into smart paste");
    console.log("PASS 5: Google Places strict compliance isolation verified (no export/push/CRM copy)");

    // ===== 6. Mobile 390px Vertical Customer Card Stream & 0px Overflow =====
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await new Promise((r) => setTimeout(r, 250));
    const mobileCheck = await cdp.evalJs(`(() => {
      navigateTo("map-scraper");
      const tbl = document.querySelector("#msResultWrap .ms-table-view");
      const cards = document.querySelector("#msResultWrap .ms-card-list");
      const tblDisp = tbl ? getComputedStyle(tbl).display : "missing";
      const cardsDisp = cards ? getComputedStyle(cards).display : "missing";
      const overflowPx = Math.max(0, document.documentElement.scrollWidth - window.innerWidth);
      const cardBtnCount = document.querySelectorAll("#msResultWrap .ms-card .ms-card-acts .pill").length;
      return { tblDisp, cardsDisp, overflowPx, cardBtnCount };
    })()`);
    assert.equal(mobileCheck.tblDisp, "none", "Desktop table MUST be hidden on 390px mobile");
    assert.equal(mobileCheck.cardsDisp, "flex", "Vertical customer card stream MUST be visible on 390px mobile");
    assert.equal(mobileCheck.overflowPx, 0, `Expected 0px horizontal overflow on 390px mobile map page, got ${mobileCheck.overflowPx}px`);
    assert.equal(mobileCheck.cardBtnCount, 3, "Mobile map card must have 3-button thumb action bar");
    console.log("PASS 6: Mobile 390px vertical map customer card stream & 0px overflow");

    // ===== 7. Lightweight Feedback Modal (Mobile footer entry + compact topbar + PII Scrub + Local Save + Escape) =====
    const fbCheck = await cdp.evalJs(`(() => {
      const topFbDisp390 = getComputedStyle(document.getElementById("btnOpenFeedback")).display;
      const footFbDisp390 = getComputedStyle(document.getElementById("btnFooterFeedback")).display;
      document.getElementById("btnFooterFeedback").click();
      const opened = !document.getElementById("feedbackModal").hidden;
      document.getElementById("fbCategory").value = "步骤繁琐";
      const msgEl = document.getElementById("fbMessage");
      msgEl.value = "联系 testbuyer@company.mx 电话 +52 81 8345 6789 时步骤有点多";
      msgEl.dispatchEvent(new Event("input"));
      const preview = document.getElementById("fbContextPreview").textContent;
      document.getElementById("btnFbCopyCard").click();
      document.getElementById("btnFbSaveLocal").click();
      const cnt = document.getElementById("fbLocalCount").textContent;
      const modalOverflow = Math.max(0, document.documentElement.scrollWidth - window.innerWidth);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      const closedOnEsc = document.getElementById("feedbackModal").hidden;
      // Also verify Turkey (Türkiye) multi-city chips, >=50 selectable countries, and DETAILS Chile/Nigeria accuracy
      const cSel = document.getElementById("msCountry");
      const selectableWithCities = Array.from(cSel.options).filter(o => window.FG_CORE.getCountryCities(o.value).length >= 4).length;
      cSel.value = "Turkey (Türkiye)";
      cSel.dispatchEvent(new Event("change"));
      const trChips = Array.from(document.querySelectorAll("#msCityChips .ms-city-chip")).map(b => b.getAttribute("data-ms-city"));
      const detChile = (typeof DETAILS !== "undefined" && DETAILS.Chile) ? DETAILS.Chile.tariff : "";
      const detNigeria = (typeof DETAILS !== "undefined" && DETAILS.Nigeria) ? (DETAILS.Nigeria.cert + " " + DETAILS.Nigeria.bans) : "";
      return {
        topFbDisp390, footFbDisp390, opened, preview, copiedCard: window._lastFeedbackCardText || "",
        cnt, modalOverflow, closedOnEsc, selectableWithCities, trChips, detChile, detNigeria
      };
    })()`);
    assert.equal(fbCheck.topFbDisp390, "none", "Desktop topbar feedback button must hide on 390px mobile to keep topbar compact");
    assert.notEqual(fbCheck.footFbDisp390, "none", "Mobile footer feedback button must remain visible on 390px");
    assert.equal(fbCheck.opened, true);
    assert.ok(!fbCheck.preview.includes("testbuyer@company.mx") && !fbCheck.preview.includes("8345 6789"), "Feedback modal MUST scrub email & phone PII");
    assert.ok(fbCheck.copiedCard.includes("v2.1-m1") && fbCheck.copiedCard.includes("390x844"));
    assert.equal(fbCheck.cnt, "1");
    assert.equal(fbCheck.modalOverflow, 0);
    assert.equal(fbCheck.closedOnEsc, true);
    assert.ok(fbCheck.selectableWithCities >= 50, `Expected >=50 selectable #msCountry countries with city chips, got ${fbCheck.selectableWithCities}`);
    assert.ok(fbCheck.trChips.includes("Istanbul") && fbCheck.trChips.length >= 5, `Turkey (Türkiye) chips missing: ${fbCheck.trChips}`);
    assert.ok(!fbCheck.detChile.includes("98%") && fbCheck.detChile.includes("排除清单"), `DETAILS.Chile must be qualified: ${fbCheck.detChile}`);
    assert.ok(fbCheck.detNigeria.includes("管制清单") && fbCheck.detNigeria.includes("豁免"), `DETAILS.Nigeria must be qualified: ${fbCheck.detNigeria}`);
    console.log("PASS 7: Lightweight Feedback Modal (mobile footer entry, PII scrubbing, local save, Escape) + 51-country Turkey chips + DETAILS accuracy");

    // ===== 8. WeChat Deep Link (?radar=<lateItemId> + ?radar=<expired>) =====
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.navigate(`${baseUrl}?radar=${encodeURIComponent(lateItemId)}#radar-live`);
    const dlValid = await cdp.evalJs(`(() => {
      const activeRadar = document.getElementById("radar-live").classList.contains("fg-active");
      const hi = document.querySelector('.radar-card.rc-highlight');
      const bannerHidden = document.getElementById("rfDeepLinkBanner").hidden;
      return { activeRadar, hiId: hi ? hi.getAttribute("data-radar-id") : "", bannerHidden };
    })()`);
    assert.equal(dlValid.activeRadar, true, "Valid ?radar= must activate radar-live");
    assert.equal(dlValid.hiId, lateItemId, `Expected highlighted card ${lateItemId} (including auto-expand beyond top 10), got ${dlValid.hiId}`);
    assert.equal(dlValid.bannerHidden, true, "Expired banner must stay hidden for valid item");

    await cdp.navigate(`${baseUrl}?radar=expired_demo_99999#radar-live`);
    const dlExpired = await cdp.evalJs(`(() => {
      const activeRadar = document.getElementById("radar-live").classList.contains("fg-active");
      const banner = document.getElementById("rfDeepLinkBanner");
      return { activeRadar, bannerVisible: !banner.hidden, bannerText: banner.textContent };
    })()`);
    assert.equal(dlExpired.activeRadar, true);
    assert.equal(dlExpired.bannerVisible, true, "Expired ?radar= ID must display explicit notice banner");
    assert.ok(dlExpired.bannerText.includes("expired_demo_99999") && dlExpired.bannerText.includes("已过时"));
    console.log(`PASS 8: WeChat ?radar=<id> deep-link valid (${lateItemId}) & expired fallback notice`);

    assert.equal(cdp.pageErrors.length, 0, `Uncaught page exceptions: ${cdp.pageErrors.join(" | ")}`);
    console.log("ALL V2.1 M1 E2E CHECKS PASSED (0 console/page errors)!");
  } finally {
    if (cdp && cdp.ws) try { cdp.ws.close(); } catch (_) {}
    chrome.kill("SIGKILL");
    srv.close();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
  }
})().catch((err) => {
  console.error("V2.1 M1 VERIFY FAILED:", err);
  process.exit(1);
});
