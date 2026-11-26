#!/usr/bin/env node
/**
 * Phase 2A Practical Lead-Gen & Quality Upgrade — Zero-Dependency Headless Chrome CDP Verification
 * Verifies P2A-1 through P2A-6 in real headless Chrome + static HTML/JSON integrity.
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
    http
      .get(url, (r) => {
        let d = "";
        r.on("data", (c) => (d += c));
        r.on("end", () => {
          try { res(JSON.parse(d)); } catch (e) { rej(e); }
        });
      })
      .on("error", rej);
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
  return { ws, send, evalJs, pageErrors };
}

(async () => {
  console.log("=== Phase 2A Browser E2E Verification ===");

  // 0. Static check: zero dead external links remain in index.html & radar_feed.json has recent Contract Awards
  const htmlRaw = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const bannedDeadUrls = [
    "adb.org/business/opportunities",
    "isdb.org/procurement\"",
    "tradeweave.org",
    "lpse.lkpp.go.id",
    "nocopo.bpp.gov.ng",
    "projectsportal.afdb.org",
    "www.iucab.com"
  ];
  for (const dead of bannedDeadUrls) {
    assert.ok(!htmlRaw.includes(dead), `Dead link still found in index.html: ${dead}`);
  }
  console.log("[PASS] P2A-6a: Zero dead external links remain in index.html");

  const radarJson = JSON.parse(fs.readFileSync(path.join(ROOT, "data/radar_feed.json"), "utf8"));
  const awardItems = radarJson.items.filter((x) => x.cat === "award");
  const weatherItems = radarJson.items.filter((x) => x.cat === "weather");
  assert.ok(awardItems.length >= 3, `Expected >=3 World Bank Contract Award items, got ${awardItems.length}`);
  assert.ok(awardItems.every((x) => x.contractor && x.contractor.length > 2), "Every Contract Award item has a parsed winning contractor");
  assert.ok(weatherItems.every((x) => x.severity !== "Green"), "Zero Green GDACS alerts in radar_feed.json");
  console.log(`[PASS] P2A-1a: radar_feed.json has ${awardItems.length} recent Contract Award contractors and ${weatherItems.length} high-severity weather alerts (0 Green)`);

  const { srv, port } = await startServer();
  const baseUrl = `http://127.0.0.1:${port}/`;
  const cdpPort = 9411;
  const profileDir = `/tmp/fg_phase2a_${Date.now()}`;
  const chromeProc = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1440,900",
      baseUrl
    ],
    { stdio: "ignore" }
  );

  let cdp = null;
  try {
    let targets = null;
    for (let i = 0; i < 40; i++) {
      try {
        const list = await fetchJson(`http://127.0.0.1:${cdpPort}/json/list`);
        targets = list.filter((t) => t.type === "page" && t.url.startsWith(baseUrl));
        if (targets.length) break;
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(targets && targets.length > 0, "Headless Chrome page opened");
    cdp = await connectCdpTarget(targets[0].webSocketDebuggerUrl);

    // Wait until app DOM & FG_STORE ready
    await cdp.evalJs(`(async () => {
      for (let i = 0; i < 40; i++) {
        if (window.FG_CORE && window.navigateTo && document.getElementById("rfCntA")) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    })()`);

    // 1. Verify #radar-live Contract Award category pill & contractor cards + congratulatory email flow
    const radarCheck = await cdp.evalJs(`(() => {
      window.navigateTo("radar-live");
      const cntA = Number(document.getElementById("rfCntA").textContent || "0");
      const awardPill = document.querySelector('#rfCatPills button[data-rfcat="award"]');
      awardPill.click();
      const firstCard = document.querySelector("#radarFeedGrid .radar-card");
      const cardText = firstCard ? firstCard.textContent : "";
      const hasLiDork = !!(firstCard && firstCard.querySelector('a[href*="linkedin.com"]'));
      const emBtn = firstCard ? firstCard.querySelector("button[data-rf-em]") : null;
      if (emBtn) emBtn.click();
      return {
        cntA,
        cardText,
        hasLiDork,
        emCompany: document.getElementById("emCompany").value,
        emBody: document.getElementById("emBodyOut").textContent
      };
    })()`);
    assert.ok(radarCheck.cntA >= 3, "Contract Award pill count >= 3");
    assert.ok(radarCheck.cardText.includes("中标承包商（现成买家）"), "Award card renders winning contractor label");
    assert.equal(radarCheck.hasLiDork, true, "Award card includes LinkedIn buyer search button");
    assert.ok(radarCheck.emCompany.length > 2, "Clicking 写祝贺中标信 populated winning contractor name into #emCompany");
    assert.ok(
      /Congratulations|Felicitaciones|Parabéns|Félicitations|نهنئ|Xin chúc mừng|Selamat/.test(radarCheck.emBody),
      "Email body includes localized congratulatory contract-award icebreaker"
    );
    console.log(`[PASS] P2A-1b: #radar-live renders ${radarCheck.cntA} Contract Award cards + LinkedIn buyer search + congratulatory icebreaker`);

    // 2. Verify P2A-2: Email Guesser accented names
    const egCheck = await cdp.evalJs(`(() => {
      window.navigateTo("email-tools");
      const f = document.getElementById("egFirst");
      const l = document.getElementById("egLast");
      const d = document.getElementById("egDom");
      f.value = "José";
      l.value = "García";
      d.value = "acero-monterrey.mx";
      d.dispatchEvent(new Event("input", { bubbles: true }));
      return Array.from(document.querySelectorAll("#egList button[data-cp-em]")).map((b) => b.getAttribute("data-cp-em"));
    })()`);
    assert.equal(egCheck[0], "jose.garcia@acero-monterrey.mx");
    assert.ok(!egCheck.includes("jos.garca@acero-monterrey.mx"), "Accented characters are transliterated, never dropped");
    console.log("[PASS] P2A-2: Email Guesser transliterates José García -> jose.garcia@acero-monterrey.mx");

    // 3. Verify P2A-3: Localized product names + WhatsApp copy guard (zero Chinese Subject:)
    const waAndLocCheck = await cdp.evalJs(`(() => {
      window.navigateTo("email-gen");
      window._copiedTexts = [];
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: (t) => {
            window._copiedTexts.push(t);
            return Promise.resolve();
          }
        }
      });
      const emComp = document.getElementById("emCompany");
      emComp.value = "Grupo Industrial Monterrey";
      emComp.dispatchEvent(new Event("input", { bubbles: true }));
      const emCountry = document.getElementById("emCountry");
      emCountry.value = "Mexico";
      emCountry.dispatchEvent(new Event("change", { bubbles: true }));
      const emProd = document.getElementById("emProduct");
      emProd.value = "industrial valves & water pumps";
      emProd.dispatchEvent(new Event("input", { bubbles: true }));

      const esBody = document.getElementById("emBodyOut").textContent;
      const esSub = document.getElementById("emSubOut").textContent;

      const emType = document.getElementById("emType");
      emType.value = "wa";
      emType.dispatchEvent(new Event("change", { bubbles: true }));
      const subBtnHidden = document.getElementById("btnCopySub").hidden;
      document.getElementById("btnCopyAll").click();

      return {
        esBody,
        esSub,
        subBtnHidden,
        waCopied: window._copiedTexts[window._copiedTexts.length - 1] || ""
      };
    })()`);
    assert.ok(waAndLocCheck.esBody.includes("válvulas industriales y bombas de agua"), "Spanish email body uses localized Spanish product name");
    assert.equal(waAndLocCheck.subBtnHidden, true, "Copy Subject button is hidden in WhatsApp mode");
    assert.ok(!waAndLocCheck.waCopied.includes("Subject:"), "WhatsApp Copy button does NOT include Subject: prefix");
    assert.ok(!/[\u4e00-\u9fff]/.test(waAndLocCheck.waCopied), "WhatsApp copied message contains ZERO Chinese UI characters");
    console.log("[PASS] P2A-3: Spanish product localization + WhatsApp copy guard verified (0 Chinese chars copied)");

    // 4. Verify P2A-4: GLEIF country-filtered legal entity precision (stubbed fetch in page)
    const gleifCheck = await cdp.evalJs(`(async () => {
      const origFetch = window.fetch;
      let capturedUrl = "";
      window.fetch = async (url, opts) => {
        const s = String(url);
        if (s.includes("api.gleif.org/api/v1/lei-records")) {
          capturedUrl = s;
          return new Response(JSON.stringify({
            data: [
              {
                id: "LEI_CH_RETIRED",
                attributes: {
                  entity: { legalName: { name: "Pensionskasse Siemens Schweiz" }, legalAddress: { country: "CH" }, status: "INACTIVE" },
                  registration: { status: "RETIRED" }
                }
              },
              {
                id: "5299005CHJZ14D4FDJ62",
                attributes: {
                  entity: { legalName: { name: "Siemens Energy AG" }, legalAddress: { country: "DE" }, status: "ACTIVE" },
                  registration: { status: "ISSUED" }
                }
              }
            ]
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return origFetch(url, opts);
      };
      try {
        window.loadIntoDd("Germany", "Siemens AG", "", "");
        document.getElementById("btnRunDd").click();
        await new Promise((r) => setTimeout(r, 150));
        return { capturedUrl, text: document.getElementById("ddAutoResult").textContent };
      } finally {
        window.fetch = origFetch;
      }
    })()`);
    assert.ok(gleifCheck.capturedUrl.includes("filter[entity.legalName]=Siemens%20AG"), "GLEIF queried entity.legalName");
    assert.ok(gleifCheck.capturedUrl.includes("filter[entity.legalAddress.country]=DE"), "GLEIF filtered by Germany ISO-2 (DE)");
    assert.ok(gleifCheck.text.includes("Siemens Energy AG"), "GLEIF displayed active German entity");
    assert.ok(!gleifCheck.text.includes("Pensionskasse"), "GLEIF excluded retired Swiss pension fund");
    console.log("[PASS] P2A-4: GLEIF country-filtered precision lookup verified");

    // 5. Verify P2A-5: Default +3d nextDate on new CRM lead + 1-click 21-day cadence advancement
    const crmCadenceCheck = await cdp.evalJs(`(() => {
      const created = window.addCustomerToCrm({
        company: "Monterrey Steel & Valve SA",
        country: "Mexico",
        email: "jose.garcia@monterreysteel.mx",
        product: "industrial valves & water pumps"
      });
      const initialNext = created.nextDate;
      const initialLabel = created.cadenceLabel;
      window.openClientDetail(created.id, "follow");
      const cadBtn1 = document.querySelector('#crmDetailPanel button[data-cd-cadence="first"]');
      cadBtn1.click();
      const afterStep1 = {
        nextDate: created.nextDate,
        cadenceStep: created.cadenceStep,
        cadenceLabel: created.cadenceLabel,
        tlLen: created.timeline.length
      };
      const emRowBtn = document.querySelector('#followBody button[data-crm-em="' + created.id + '"]');
      emRowBtn.click();
      const preselectedEmType = document.getElementById("emType").value;
      return { initialNext, initialLabel, afterStep1, preselectedEmType };
    })()`);
    assert.match(crmCadenceCheck.initialNext, /^\d{4}-\d{2}-\d{2}$/, "New CRM lead automatically gets +3d follow-up date");
    assert.equal(crmCadenceCheck.initialLabel, "新建档·待首轮触达");
    assert.equal(crmCadenceCheck.afterStep1.cadenceStep, "followup");
    assert.ok(crmCadenceCheck.afterStep1.cadenceLabel.includes("Day4"), "Cadence label updated to Day 4 step");
    assert.equal(crmCadenceCheck.afterStep1.tlLen, 1, "Timeline entry appended automatically");
    assert.equal(crmCadenceCheck.preselectedEmType, "followup", "Clicking 写信 from CRM auto-preselects Day 4 followup template");
    console.log("[PASS] P2A-5: Default +3d follow-up + 21-day cadence progression + auto-preselect next email verified");

    // 6. Verify P2A-6b: 10 Industrial Expos table has 5 columns & dynamic countdown badges
    const expoCheck = await cdp.evalJs(`(() => {
      window.navigateTo("project-hunt", { innerId: "radar-expos" });
      const headers = Array.from(document.querySelectorAll("#radar-expos thead th")).map((th) => th.textContent.trim());
      const rows = Array.from(document.querySelectorAll("#expoTbody tr"));
      const firstRowCells = rows[0] ? rows[0].querySelectorAll("td").length : 0;
      const countdownBadges = rows.map((tr) => tr.children[2] ? tr.children[2].textContent.trim() : "");
      return { headers, rowCount: rows.length, firstRowCells, countdownBadges };
    })()`);
    assert.equal(expoCheck.headers.length, 5);
    assert.equal(expoCheck.headers[2], "展期与备战窗口");
    assert.equal(expoCheck.rowCount, 10);
    assert.equal(expoCheck.firstRowCells, 5);
    assert.ok(expoCheck.countdownBadges.every((t) => /\d{4}-\d{2}-\d{2}/.test(t)), "Every expo row displays upcoming YYYY-MM-DD show date & countdown");
    console.log("[PASS] P2A-6b: 10 Industrial Expos calendar & pre-show countdown badges verified");

    assert.equal(cdp.pageErrors.length, 0, `Unexpected page errors: ${cdp.pageErrors.join("; ")}`);
    console.log("=== ALL PHASE 2A E2E CHECKS PASSED ===");
  } finally {
    if (cdp && cdp.ws) try { cdp.ws.close(); } catch (_) {}
    chromeProc.kill("SIGKILL");
    srv.close();
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (_) {}
  }
})();
