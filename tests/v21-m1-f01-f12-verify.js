#!/usr/bin/env node
/**
 * V2.1 M1 Independent Audit Defect Regression Suite (F01 - F12)
 * Verifies every single P1/P2/P3 finding from the 2026-11-27 GPT audit with real Headless Chrome + exact repro inputs.
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
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
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
  const send = (method, params = {}) => new Promise((res, rej) => {
    pend.set(++seq, { res, rej });
    ws.send(JSON.stringify({ id: seq, method, params }));
  });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const evalJs = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r && r.exceptionDetails) throw new Error("Eval exception: " + JSON.stringify(r.exceptionDetails));
    return r && r.result ? r.result.value : undefined;
  };
  const navigate = async (url) => {
    await send("Page.navigate", { url });
    await new Promise((r) => setTimeout(r, 800));
  };
  return { ws, send, evalJs, navigate, pageErrors };
}

(async () => {
  const { srv, port } = await startServer();
  const baseUrl = `http://127.0.0.1:${port}/`;
  const userDataDir = `/tmp/fg-f01-f12-verify-${Date.now()}`;
  const dbgPort = 9440 + Math.floor(Math.random() * 400);
  const chrome = spawn(
    CHROME,
    ["--headless=new", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${userDataDir}`, baseUrl],
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
    await new Promise((r) => setTimeout(r, 800));

    // ===== F03: Public Terms of Service & Privacy Policy pages + UI links =====
    const termsRes = await fetch(baseUrl + "terms.html");
    const termsHtml = await termsRes.text();
    const privRes = await fetch(baseUrl + "privacy.html");
    const privHtml = await privRes.text();
    assert.equal(termsRes.status, 200, "terms.html must return HTTP 200");
    assert.equal(privRes.status, 200, "privacy.html must return HTTP 200");
    assert.ok(termsHtml.includes("maps.google.com/help/terms_maps") && termsHtml.includes("policies.google.com/privacy"), "terms.html must link Google Maps Terms & Privacy Policy");
    assert.ok(privHtml.includes("policies.google.com/privacy") && privHtml.includes("localStorage") && privHtml.includes("Cloudflare D1"), "privacy.html must disclose local/cloud storage & Google Privacy Policy");
    const f03Links = await cdp.evalJs(`(() => {
      const footerHtml = document.querySelector("footer").innerHTML;
      const gmapsHtml = document.getElementById("gmapsCfgBox").innerHTML + document.getElementById("gmapsTermsBanner").innerHTML;
      return {
        footerTerms: footerHtml.includes("terms.html"),
        footerPrivacy: footerHtml.includes("privacy.html"),
        gmapsTerms: gmapsHtml.includes("terms.html") && gmapsHtml.includes("maps.google.com/help/terms_maps"),
        gmapsPrivacy: gmapsHtml.includes("privacy.html") && gmapsHtml.includes("policies.google.com/privacy")
      };
    })()`);
    assert.equal(f03Links.footerTerms, true, "Footer must link terms.html");
    assert.equal(f03Links.footerPrivacy, true, "Footer must link privacy.html");
    assert.equal(f03Links.gmapsTerms, true, "Google Maps config/banner must link terms.html & Google Terms");
    assert.equal(f03Links.gmapsPrivacy, true, "Google Maps config/banner must link privacy.html & Google Privacy");
    console.log("PASS F03: Public Terms of Service & Privacy Policy pages + footer/Google Maps compliance links verified");

    // ===== F02 & F11: Feedback PII redaction, manual review guard, no false absolute promise, explicit UTC+8 =====
    const f02Check = await cdp.evalJs(`(() => {
      document.getElementById("btnOpenFeedback").click();
      const msgEl = document.getElementById("fbMessage");
      msgEl.value = "测试示例：客户张三，示例工业有限公司，报价 USD 1234，密码 DemoOnlySecret，邮箱 qa@example.com，链接 https://api.example.com?token=SecretTok99";
      msgEl.dispatchEvent(new Event("input"));
      const modalText = document.getElementById("feedbackModal").textContent;
      const preview = document.getElementById("fbContextPreview").textContent;
      const warnVisible = !document.getElementById("fbSensitiveWarn").hidden;
      const warnTxt = document.getElementById("fbSensitiveWarn").textContent;
      const checkVisible = !document.getElementById("fbManualCheckWrap").hidden;
      // Attempt copy/save BEFORE checking manual review -> MUST be blocked
      window._lastFeedbackCardText = "";
      document.getElementById("btnFbCopyCard").click();
      const blockedCopy = window._lastFeedbackCardText === "";
      document.getElementById("btnFbSaveLocal").click();
      const blockedSaveCnt = document.getElementById("fbLocalCount").textContent;
      // Now check manual review -> allowed
      document.getElementById("fbManualCheckOk").checked = true;
      document.getElementById("btnFbCopyCard").click();
      const allowedAfterCheck = window._lastFeedbackCardText.includes("【FriesGo 工作台改进反馈】");
      document.getElementById("btnCloseFeedback").click();
      return { modalText, preview, warnVisible, warnTxt, checkVisible, blockedCopy, blockedSaveCnt, allowedAfterCheck };
    })()`);
    assert.ok(!f02Check.modalText.includes("绝不含客户明细"), "Must remove false absolute zero-privacy guarantee from modal");
    assert.ok(!f02Check.preview.includes("不含客户明细、报价与密码"), "Must remove false absolute guarantee from card text");
    assert.ok(!f02Check.preview.includes("qa@example.com") && f02Check.preview.includes("[已脱敏邮箱]"), "Email must be scrubbed");
    assert.ok(!f02Check.preview.includes("DemoOnlySecret") && f02Check.preview.includes("[已脱敏凭证]"), "Password must be scrubbed");
    assert.ok(!f02Check.preview.includes("1234") && f02Check.preview.includes("[已脱敏金额]"), "Quote amount must be scrubbed");
    assert.ok(!f02Check.preview.includes("SecretTok99") && f02Check.preview.includes("[已脱敏链接]"), "URL with token must be scrubbed");
    assert.equal(f02Check.warnVisible, true, "Sensitive risk warning banner must appear for customer/company names");
    assert.equal(f02Check.checkVisible, true, "Manual review checkbox must appear for customer/company names");
    assert.equal(f02Check.blockedCopy, true, "Copy must be blocked before manual review confirmation");
    assert.equal(f02Check.blockedSaveCnt, "0", "Save must be blocked before manual review confirmation");
    assert.equal(f02Check.allowedAfterCheck, true, "Copy must succeed after explicit manual review check");
    assert.ok(f02Check.preview.includes("(UTC+8)"), `F11: Timestamp must explicitly mark UTC+8, got: ${f02Check.preview}`);
    console.log("PASS F02 & F11: Feedback credentials/amounts/URL scrubbing, manual review gate, honest boundary & UTC+8 timestamp verified");

    // ===== F07: Product-conditional 60Hz motor alert (manual valve vs pump vs cable) =====
    const f07Check = await cdp.evalJs(`(() => {
      navigateTo("quote-calc");
      const qcSel = document.getElementById("qcCountry");
      qcSel.value = "Saudi Arabia";
      qcSel.dispatchEvent(new Event("change"));
      const prodInp = document.getElementById("qcProdName");
      function runFor(name) {
        prodInp.value = name;
        prodInp.dispatchEvent(new Event("input"));
        const bar = document.getElementById("qcSpecGuardBar");
        return { cls: bar.className, txt: bar.textContent };
      }
      const manualValve = runFor("Manual ball valve, no motor");
      const waterPump = runFor("Centrifugal water pump");
      const powerCable = runFor("Armored power cable 11kV");
      return { manualValve, waterPump, powerCable };
    })()`);
    assert.ok(!f07Check.manualValve.cls.includes("lv-red"), `Manual valve must NOT trigger red alert, got: ${f07Check.manualValve.cls}`);
    assert.ok(!f07Check.manualValve.txt.includes("60Hz 电机/水泵防错警报"), `Manual valve must NOT show motor 60Hz alarm, got: ${f07Check.manualValve.txt}`);
    assert.ok(!f07Check.manualValve.txt.includes("强制清关"), `Manual valve must NOT claim blanket mandatory clearance, got: ${f07Check.manualValve.txt}`);
    assert.ok(f07Check.waterPump.cls.includes("lv-red") && f07Check.waterPump.txt.includes("60Hz 电机/水泵防错警报"), "Water pump in Saudi MUST trigger red 60Hz motor alarm");
    assert.ok(f07Check.powerCable.cls.includes("lv-yellow") && !f07Check.powerCable.txt.includes("60Hz 电机/水泵防错警报") && f07Check.powerCable.txt.includes("电力/线缆"), "Power cable must show tailored electrical notice, not motor alarm");
    console.log("PASS F07: Product-conditional 60Hz/electrical/manual-valve guardrails verified across 3 product classes");

    // ===== F01, F04, F05, F06, F08, F10: Adversarial OSM/Photon Matrix =====
    const osmMatrix = await cdp.evalJs(`(async () => {
      navigateTo("map-scraper");
      const cSel = document.getElementById("msCountry");
      cSel.value = "Saudi Arabia";
      cSel.dispatchEvent(new Event("change"));
      document.getElementById("msCity").value = "Jeddah";
      document.getElementById("msRadius").value = "30000";

      const realFetch = window.fetch;
      const out = {};

      // 1) F01: allfail (Overpass rejects + all 6 Photon reject) -> NEVER "真实零条"
      window.fetch = (url) => {
        const u = String(url);
        if (u.includes("limit=1&")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ features: [{ geometry: { coordinates: [39.1925, 21.4858] } }] }) });
        return Promise.reject(new Error("synthetic offline"));
      };
      window._resetOsmThrottle();
      document.getElementById("btnRunMapScrape").click();
      await new Promise(r => setTimeout(r, 250));
      out.f01_allfail = document.getElementById("msStatus").textContent;

      // 2) F01b: partial failure (3 Photon 200 empty + 3 Photon 500 error) -> NEVER verified "真实零条"
      let pIdx = 0;
      window.fetch = (url) => {
        const u = String(url);
        if (u.includes("limit=1&")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ features: [{ geometry: { coordinates: [39.1925, 21.4858] } }] }) });
        if (u.includes("overpass-api.de")) return Promise.reject(new Error("timeout"));
        if (u.includes("limit=25")) {
          pIdx++;
          if (pIdx <= 3) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ features: [] }) });
          return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
        }
        return Promise.reject(new Error("blocked"));
      };
      window._resetOsmThrottle();
      document.getElementById("btnRunMapScrape").click();
      await new Promise(r => setTimeout(r, 250));
      out.f01_partialFailZero = document.getElementById("msStatus").textContent;

      // 3) F01c: true clean zero (Overpass clean empty + all 6 Photon 200 empty) -> MAY say "真实零条"
      window.fetch = (url) => {
        const u = String(url);
        if (u.includes("limit=1&")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ features: [{ geometry: { coordinates: [39.1925, 21.4858] } }] }) });
        if (u.includes("overpass-api.de")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ elements: [] }) });
        if (u.includes("limit=25")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ features: [] }) });
        return Promise.reject(new Error("blocked"));
      };
      window._resetOsmThrottle();
      document.getElementById("btnRunMapScrape").click();
      await new Promise(r => setTimeout(r, 250));
      out.f01_trueZero = document.getElementById("msStatus").textContent;

      // 4) F04: cancel during hanging Photon fallback -> stays "已取消", never overwritten by "真实零条"
      let photonStarted = false;
      window.fetch = (url, opts = {}) => {
        const u = String(url);
        if (u.includes("limit=1&")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ features: [{ geometry: { coordinates: [39.1925, 21.4858] } }] }) });
        if (u.includes("overpass-api.de")) return Promise.reject(new Error("overpass down"));
        if (u.includes("limit=25")) {
          photonStarted = true;
          return new Promise((_, reject) => {
            const abort = () => reject(new DOMException("Aborted", "AbortError"));
            if (opts.signal && opts.signal.aborted) abort();
            else if (opts.signal) opts.signal.addEventListener("abort", abort, { once: true });
          });
        }
        return Promise.reject(new Error("blocked"));
      };
      window._resetOsmThrottle();
      document.getElementById("btnRunMapScrape").click();
      for (let i = 0; i < 40 && !photonStarted; i++) await new Promise(r => setTimeout(r, 15));
      document.getElementById("btnCancelOsm").click();
      await new Promise(r => setTimeout(r, 250));
      out.f04_cancelStatus = document.getElementById("msStatus").textContent;
      out.f04_cancelHidden = document.getElementById("btnCancelOsm").hidden;

      // 5) F05: Overpass 429 with Retry-After -> 0 Photon calls + cooldown blocks immediate retry
      let photonOn429 = 0;
      let totalCallsAfter429 = 0;
      window.fetch = (url) => {
        const u = String(url);
        if (u.includes("limit=1&")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ features: [{ geometry: { coordinates: [39.1925, 21.4858] } }] }) });
        if (u.includes("overpass-api.de")) return Promise.resolve({ ok: false, status: 429, headers: new Headers({ "Retry-After": "20" }), json: () => Promise.resolve({}) });
        if (u.includes("limit=25")) { photonOn429++; return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ features: [] }) }); }
        return Promise.reject(new Error("blocked"));
      };
      window._resetOsmThrottle();
      document.getElementById("btnRunMapScrape").click();
      await new Promise(r => setTimeout(r, 200));
      out.f05_429Status = document.getElementById("msStatus").textContent;
      out.f05_photonOn429 = photonOn429;
      // Retry during cooldown -> must make 0 calls
      window.fetch = () => { totalCallsAfter429++; return Promise.reject(new Error("should not call during cooldown")); };
      document.getElementById("btnRunMapScrape").click();
      await new Promise(r => setTimeout(r, 100));
      out.f05_callsDuringCooldown = totalCallsAfter429;
      out.f05_cooldownStatus = document.getElementById("msStatus").textContent;

      // 6) F06: Overpass HTTP 200 with remark: "runtime error: Query timed out" -> partial, NOT complete
      window.fetch = (url) => {
        const u = String(url);
        if (u.includes("limit=1&")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ features: [{ geometry: { coordinates: [39.1925, 21.4858] } }] }) });
        if (u.includes("overpass-api.de")) return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({
            remark: "runtime error: Query timed out",
            elements: [{ lat: 21.486, lon: 39.193, tags: { name: "Synthetic Valve Factory", industrial: "valve" } }]
          })
        });
        return Promise.reject(new Error("blocked"));
      };
      window._resetOsmThrottle();
      document.getElementById("btnRunMapScrape").click();
      await new Promise(r => setTimeout(r, 200));
      out.f06_partialStatus = document.getElementById("msStatus").textContent;
      out.f06_cardCount = document.querySelectorAll("#msResultWrap .ms-card").length;

      // 7) F08 & F10 & F05-expand-throttle: Haversine circular filter + Arabic industrial city zone separation + expand throttle + updated 36km display + concurrency <= 2
      let inFlight = 0, maxInFlight = 0, expandBlockedCalls = 0;
      window.fetch = (url) => {
        const u = String(url);
        if (u.includes("limit=1&")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ features: [{ geometry: { coordinates: [39.1925, 21.4858] } }] }) });
        if (u.includes("overpass-api.de")) return Promise.reject(new Error("fallback to photon"));
        if (u.includes("limit=25")) {
          inFlight++;
          if (inFlight > maxInFlight) maxInFlight = inFlight;
          return new Promise((resolve) => setTimeout(() => {
            inFlight--;
            resolve({
              ok: true, status: 200,
              json: () => Promise.resolve({
                features: [
                  // Inside 30km circle (~1km from center), real company without phone
                  { geometry: { coordinates: [39.20, 21.49] }, properties: { name: "El-Badr Industrial Supplies Co. Ltd.", osm_key: "shop", osm_value: "hardware", city: "Jeddah" } },
                  // Inside 30km circle (~2km), Arabic industrial city (landuse=industrial) -> MUST be separated as zone!
                  { geometry: { coordinates: [39.21, 21.49] }, properties: { name: "جدة أول مدينة صناعية", osm_key: "landuse", osm_value: "industrial", city: "Jeddah" } },
                  // Inside 30km BBOX corner (~39km from center) -> MUST be filtered out of 30km circle!
                  { geometry: { coordinates: [39.46, 21.74] }, properties: { name: "Far Corner Outside Circle Co.", osm_key: "industrial", osm_value: "factory", city: "Jeddah" } }
                ]
              })
            });
          }, 15));
        }
        return Promise.reject(new Error("blocked"));
      };
      window._resetOsmThrottle();
      document.getElementById("btnRunMapScrape").click();
      await new Promise(r => setTimeout(r, 350));
      out.f08_f10_status1 = document.getElementById("msStatus").textContent;
      out.f08_maxConcurrency = maxInFlight;
      out.f08_hasCorner = document.getElementById("msResultWrap").textContent.includes("Far Corner Outside Circle Co.");
      out.f10_companyCards = document.querySelectorAll('#msResultWrap .ms-card[data-entity-kind="company"]').length;
      out.f10_zoneCards = document.querySelectorAll('#msResultWrap .ms-card[data-entity-kind="zone"]').length;
      out.f10_zoneHasCrmBtn = document.querySelectorAll('#msResultWrap .ms-card[data-entity-kind="zone"] button[data-map-crm]').length;
      out.f10_companyHasCrmBtn = document.querySelectorAll('#msResultWrap .ms-card[data-entity-kind="company"] button[data-map-crm]').length;

      // Immediate click btnOsmMore within 2s -> MUST be throttled (0 fetches!)
      const prevFetch = window.fetch;
      window.fetch = () => { expandBlockedCalls++; return Promise.reject(new Error("should be throttled")); };
      document.getElementById("btnOsmMore").click();
      await new Promise(r => setTimeout(r, 100));
      out.f05_expandThrottledCalls = expandBlockedCalls;

      // Reset throttle and click btnOsmMore -> radius expands 30km -> 36km and UI MUST display 36 km
      window.fetch = prevFetch;
      window._resetOsmThrottle();
      document.getElementById("btnOsmMore").click();
      await new Promise(r => setTimeout(r, 350));
      out.f08_expandStatus = document.getElementById("msStatus").textContent;

      window.fetch = realFetch;
      return out;
    })()`);

    assert.ok(!osmMatrix.f01_allfail.includes("真实零条") && osmMatrix.f01_allfail.includes("失败"), `F01 allfail must show failure, not zero: ${osmMatrix.f01_allfail}`);
    assert.ok(!osmMatrix.f01_partialFailZero.includes("真实零条") && osmMatrix.f01_partialFailZero.includes("未完整完成"), `F01 partial-fail zero must warn incomplete: ${osmMatrix.f01_partialFailZero}`);
    assert.ok(osmMatrix.f01_trueZero.includes("真实零条结果"), `F01 clean zero must display true zero: ${osmMatrix.f01_trueZero}`);
    assert.ok(osmMatrix.f04_cancelStatus.includes("已取消") && !osmMatrix.f04_cancelStatus.includes("真实零条") && osmMatrix.f04_cancelHidden, `F04 cancel must stay cancelled: ${osmMatrix.f04_cancelStatus}`);
    assert.equal(osmMatrix.f05_photonOn429, 0, "F05: Overpass 429 must NOT trigger Photon fallback storm");
    assert.ok(osmMatrix.f05_429Status.includes("429") && osmMatrix.f05_429Status.includes("20 秒冷却"), `F05: Must respect Retry-After 20s: ${osmMatrix.f05_429Status}`);
    assert.equal(osmMatrix.f05_callsDuringCooldown, 0, "F05: Must block requests during 429 cooldown");
    assert.equal(osmMatrix.f05_expandThrottledCalls, 0, "F05: Expand search must respect 2s throttle");
    assert.ok(osmMatrix.f08_maxConcurrency <= 2, `F05: Photon batch concurrency must be <= 2, got ${osmMatrix.f08_maxConcurrency}`);
    assert.ok(osmMatrix.f06_partialStatus.includes("部分结果") && osmMatrix.f06_partialStatus.includes("超时") && osmMatrix.f06_cardCount === 1, `F06: Overpass remark must be flagged partial: ${osmMatrix.f06_partialStatus}`);
    assert.equal(osmMatrix.f08_hasCorner, false, "F08: Corner point outside 30km circle must be filtered out by Haversine");
    assert.ok(osmMatrix.f08_expandStatus.includes("36 km"), `F08: Expanded search status must display 36 km, got: ${osmMatrix.f08_expandStatus}`);
    assert.ok(osmMatrix.f08_f10_status1.includes("找到 1 家工业企业") && osmMatrix.f08_f10_status1.includes("1 处工业园区"), `F10: Must separate 1 company from 1 industrial zone: ${osmMatrix.f08_f10_status1}`);
    assert.equal(osmMatrix.f10_companyCards, 1, "F10: Exactly 1 company card");
    assert.equal(osmMatrix.f10_zoneCards, 1, "F10: Exactly 1 zone card");
    assert.equal(osmMatrix.f10_zoneHasCrmBtn, 0, "F10: Industrial zone must NOT have Save-to-CRM button");
    assert.equal(osmMatrix.f10_companyHasCrmBtn, 1, "F10: Real company without phone MUST keep Save-to-CRM button");
    console.log("PASS F01, F04, F05, F06, F08, F10: Full adversarial OSM/Photon failure, cancel, 429, partial, Haversine & zone matrix verified");

    // ===== F09: Strict 360px / 375px / 390px / 768px / 1024px / 1440px 0px overflow (exact CSS width, mobile: false to prevent auto-zoom) =====
    for (const w of [360, 375, 390, 768, 1024, 1440]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: 800, deviceScaleFactor: 1, mobile: false });
      await new Promise((r) => setTimeout(r, 120));
      const dim = await cdp.evalJs(`(() => {
        navigateTo("map-scraper");
        const radRect = document.getElementById("msRadius").getBoundingClientRect();
        const ovMap = Math.max(0, document.documentElement.scrollWidth - window.innerWidth);
        navigateTo("quote-calc");
        const ovQuote = Math.max(0, document.documentElement.scrollWidth - window.innerWidth);
        return { width: window.innerWidth, ovMap, ovQuote, radRight: Math.round(radRect.right) };
      })()`);
      assert.equal(dim.width, w, `Viewport width must match exact ${w}px without auto-scaling`);
      assert.equal(dim.ovMap, 0, `F09: Map Scraper must have 0px overflow at ${w}px (got ${dim.ovMap}px, #msRadius right=${dim.radRight})`);
      assert.equal(dim.ovQuote, 0, `F09: Quote Calc must have 0px overflow at ${w}px (got ${dim.ovQuote}px)`);
      assert.ok(dim.radRight <= w, `F09: #msRadius right edge (${dim.radRight}) must stay <= ${w}px`);
    }
    console.log("PASS F09: Exact 360px/375px/390px/768px/1024px/1440px viewports verified with 0px overflow (#msRadius inside viewport)");

    // ===== F12: Weekly brief counts old customer updated in last 7d (and respects soft-delete/restore, without conflating with outreach) =====
    const f12Check = await cdp.evalJs(`(() => {
      const b1 = window.FG_CORE.buildPersonalWeeklyBrief([
        { id: "old_1", company: "Old Co", createdAt: "2026-01-01", updated: "2026-11-27", timeline: [] }
      ], "2026-11-27");
      const b2 = window.FG_CORE.buildPersonalWeeklyBrief([
        { id: "del_1", company: "Del Co", createdAt: "2026-01-01", updated: "2026-11-27", deletedAt: "2026-11-27T08:00:00Z", timeline: [] },
        { id: "rest_1", company: "Restored Co", createdAt: "2026-01-01", updated: "2026-11-27", deletedAt: null, timeline: [] }
      ], "2026-11-27");
      return { b1, b2 };
    })()`);
    assert.equal(f12Check.b1.added7d, 1, "F12: Old lead updated on 2026-11-27 must count as 1 in added/updated 7d");
    assert.equal(f12Check.b1.newCreated7d, 0, "F12: Must distinguish newCreated7d=0");
    assert.equal(f12Check.b1.updatedOnly7d, 1, "F12: Must distinguish updatedOnly7d=1");
    assert.equal(f12Check.b1.funnel.touched7d, 0, "F12: Record edit must NOT be conflated with valid outreach touched7d");
    assert.equal(f12Check.b2.funnel.totalActive, 1, "F12: Deleted lead must be excluded");
    assert.equal(f12Check.b2.added7d, 1, "F12: Restored lead updated within 7d must be counted");
    console.log("PASS F12: Personal weekly brief accurately counts old customer recent updates & respects delete/restore without conflating outreach");

    assert.equal(cdp.pageErrors.length, 0, `Expected 0 page errors, got: ${cdp.pageErrors.join("; ")}`);
    console.log("ALL 12 AUDIT DEFECT VERIFICATIONS (F01 - F12) PASSED WITH 0 PAGE ERRORS!");
  } finally {
    if (cdp && cdp.ws) try { cdp.ws.close(); } catch (_) {}
    chrome.kill("SIGKILL");
    srv.close();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
  }
})().catch((err) => {
  console.error("F01-F12 VERIFY FAILED:", err);
  process.exit(1);
});
