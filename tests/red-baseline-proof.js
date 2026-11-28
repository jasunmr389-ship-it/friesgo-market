#!/usr/bin/env node
/**
 * FriesGo Global - Pre-Fix Defect Reproduction Baseline (TDD Step 0)
 * Verifies all 14 confirmed defects + Worker QuotaLimiter DO status deterministically.
 * Before Phase 1 fixes: all flags are expected to be `false`.
 * After Phase 1 fixes: all flags MUST be `true`.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const CHROME = require("./_chrome.cjs").findChrome();

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = decodeURIComponent(req.url.split("?")[0]);
      const fp = path.join(ROOT, u === "/" ? "/index.html" : u);
      if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
        res.writeHead(404); res.end("404"); return;
      }
      const mimes = {
        ".html": "text/html;charset=utf-8",
        ".js": "application/javascript;charset=utf-8",
        ".json": "application/json;charset=utf-8",
        ".png": "image/png"
      };
      res.writeHead(200, { "Content-Type": mimes[path.extname(fp)] || "text/plain" });
      res.end(fs.readFileSync(fp));
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}

(async () => {
  const workerSrc = fs.readFileSync(path.join(ROOT, "workers/gmaps-proxy.js"), "utf8");
  const worker_hasQuotaLimiterDO = /export\s+class\s+QuotaLimiter\b/.test(workerSrc) && /950/.test(workerSrc);

  const { srv, port } = await startServer();
  const { spawnChromeEphemeralCdp } = require("./_chrome.cjs");
  const { proc: chrome, cdpPort } = await spawnChromeEphemeralCdp({
    profileDir: "/tmp/fg_tdd_red_" + Date.now(),
    url: "http://127.0.0.1:" + port + "/"
  });

  try {
    let targets = null;
    for (let i = 0; i < 40; i++) {
      try {
        targets = JSON.parse(await new Promise((res, rej) => http.get(`http://127.0.0.1:${cdpPort}/json`, r => {
          let d = ""; r.on("data", c => d += c); r.on("end", () => res(d));
        }).on("error", rej)));
        if (targets && targets.find(t => t.type === "page")) break;
      } catch (_) {}
      await new Promise(r => setTimeout(r, 150));
    }
    const ws = new WebSocket(targets.find(t => t.type === "page").webSocketDebuggerUrl);
    await new Promise(r => ws.onopen = r);
    let seq = 0; const pend = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
    const send = (method, params = {}) => new Promise(res => { pend.set(++seq, res); ws.send(JSON.stringify({ id: seq, method, params })); });
    await send("Runtime.enable");
    await new Promise(r => setTimeout(r, 1200));

    const checks = (await send("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        // 1. BUG-01: SPF XSS check
        window.__xss = 0;
        const origDoh = window.queryDoh;
        window.queryDoh = () => new Promise(() => {});
        document.getElementById("spfDom").value = '<img src=x onerror="window.__xss=1">';
        document.getElementById("btnCheckSpf").click();
        await new Promise(r => setTimeout(r, 120));
        window.queryDoh = origDoh;
        const bug01_xssSafe = window.__xss === 0;

        // 2. BUG-03: Default conservative tax mode (Small-scale taxpayer / unconfirmed = 0% deducted rebate on base price)
        navigateTo("quote-calc");
        const setV = (id, v) => { const el = document.getElementById(id); if (!el) return; el.value = v; el.dispatchEvent(new Event("input")); el.dispatchEvent(new Event("change")); };
        const taxModeEl = document.getElementById("qcTaxMode");
        // Under default mode with ¥100,000 factory price, FX 7.0, margin 20%, 0 local/bank/comm:
        // Conservative 0-rebate FOB should be $100,000 / 7 / 0.8 = $17,857.14 (not $15,802 with blind 13% rebate)
        setV("qcFactoryRmb", "100000"); setV("qcQty", "1"); setV("qcFx", "7.0"); setV("qcMargin", "20");
        setV("qcLocalRmb", "0"); setV("qcBankUsd", "0"); setV("qcCommPct", "0"); setV("qcFreightUsd", "0"); setV("qcInsPct", "0");
        const fobDefault = window._lastQuoteState ? window._lastQuoteState.fobUsd : 0;
        const bug03_conservativeDefaultNoBlind13 = !!(taxModeEl && fobDefault >= 17857);

        // 3. BUG-04: CIF commission covers freight & insurance (when comm=5%, frt=$4000, ins=0%, CIF > FOB + 4000)
        setV("qcCommPct", "5"); setV("qcFreightUsd", "4000"); setV("qcInsPct", "0");
        const s4 = window._lastQuoteState || {};
        const bug04_cifIncludesFreightComm = !!(s4.cifUsd && s4.fobUsd && (s4.cifUsd > s4.fobUsd + 4005));

        // 4. BUG-02 & BUG-09: Fastener low unit-price precision & stale _lastQuoteState clear on invalid input
        const btnUnit = document.querySelector('#qcPriceModePills [data-qmode="unit"]');
        if (btnUnit) btnUnit.click();
        setV("qcFactoryRmb", "0.15"); setV("qcQty", "100000"); setV("qcFx", "7.2"); setV("qcMargin", "20");
        setV("qcLocalRmb", "0"); setV("qcBankUsd", "0"); setV("qcCommPct", "0");
        const fobFastener = window._lastQuoteState ? window._lastQuoteState.fobUsd : 0;
        // Even with 13% rebate, 13274.34 / 7.2 / 0.8 = $2304.57 (2-dec rounded $0.02 * 100k = $2000 lost $304!). Without rebate it's $2604.17.
        const bug02_fastenerNoUnderprice = fobFastener >= 2304;

        setV("qcQty", "0");
        const bug09_staleCleared = !!(window._lastQuoteState && window._lastQuoteState.ok === false);

        // 5. BUG-05, BUG-06, BUG-07: Container 6m pipe 40GP, 30t single unit block, OOG stale clear + noStack
        navigateTo("container-calc");
        while (document.querySelectorAll("#ctnTbody button[data-cdel]").length > 0) document.querySelector("#ctnTbody button[data-cdel]").click();
        document.getElementById("btnAddCtnRow").click();
        let tr = document.querySelector("#ctnTbody tr");
        [["name","6m管"],["l","600"],["w","50"],["h","50"],["kg","300"],["qty","10"]].forEach(([k,v]) => { const inp = tr.querySelector('[data-ck="'+k+'"]'); inp.value = v; inp.dispatchEvent(new Event("input",{bubbles:true})); });
        const bug07_allows40Gp = document.getElementById("ctnRecOut").textContent.includes("40'GP");

        [["name","30t主机"],["l","400"],["w","200"],["h","200"],["kg","30000"],["qty","1"]].forEach(([k,v]) => { const inp = tr.querySelector('[data-ck="'+k+'"]'); inp.value = v; inp.dispatchEvent(new Event("input",{bubbles:true})); });
        const rec30t = document.getElementById("ctnRecOut").textContent;
        const bug05_blocksMultiDry = !rec30t.includes("2 × 20'GP") && !rec30t.includes("2 × 40'HQ");

        [["name","超宽件"],["l","300"],["w","260"],["h","200"],["kg","1000"],["qty","1"]].forEach(([k,v]) => { const inp = tr.querySelector('[data-ck="'+k+'"]'); inp.value = v; inp.dispatchEvent(new Event("input",{bubbles:true})); });
        const inpQty = tr.querySelector('[data-ck="qty"]'); inpQty.value = "0"; inpQty.dispatchEvent(new Event("input",{bubbles:true}));
        const hasNoStackCtrl = !!tr.querySelector('[data-ck="noStack"]');
        const bug06_oogClearedAndNoStack = document.getElementById("ctnOogWarn").textContent === "" && hasNoStackCtrl;

        // 6. BUG-08: CRM IndexedDB authoritative store
        const bug08_crmIndexedDbAuthoritative = !!(window.FG_STORE && typeof window.FG_STORE.getAllLeads === "function");

        // 7. BUG-10: effImpM scope purity on Ukraine (missing IND)
        state.scope = "ind";
        const ukrRow = DATA.find(d => d.country === "Ukraine");
        const bug10_noFullFallback = effImpM(ukrRow) === null;

        // 8. BUG-11 & BUG-12: Phone extension & Italy 0 & CSV cross-country same name
        const bug11_extStripped = analyzePhone("+52 81 8345 6789 ext. 204", "Mexico").digits === "528183456789";
        const bug11_italyZero = analyzePhone("02 12345678", "Italy").digits === "390212345678";
        navigateTo("csv-workbench");
        document.getElementById("btnClearCsv").click();
        document.getElementById("csvPasteInput").value = "Company,Country\\nDelta Valve,Vietnam\\nDelta Valve,Mexico";
        document.getElementById("btnParseCsv").click();
        const bug12_crossCountryKept = document.querySelectorAll("#csvTbody tr").length === 2;

        // 9. BUG-13: Browser history pushState
        const h0 = history.length;
        navigateTo("market-table"); navigateTo("email-gen");
        const bug13_historyPushed = history.length > h0;

        // 10. BUG-14: DD check completion decoupled from risk decision
        navigateTo("duediligence");
        document.querySelectorAll("#ddVerdictChecks input").forEach(cb => { cb.checked = true; cb.dispatchEvent(new Event("change",{bubbles:true})); });
        const ddBadgeHtml = document.getElementById("ddScoreBadge").innerHTML;
        const bug14_ddDecoupledRiskDecision = !ddBadgeHtml.includes("share-best");

        return {
          bug01_xssSafe,
          bug02_fastenerNoUnderprice,
          bug03_conservativeDefaultNoBlind13,
          bug04_cifIncludesFreightComm,
          bug05_blocksMultiDry,
          bug06_oogClearedAndNoStack,
          bug07_allows40Gp,
          bug08_crmIndexedDbAuthoritative,
          bug09_staleCleared,
          bug10_noFullFallback,
          bug11_extStripped,
          bug11_italyZero,
          bug12_crossCountryKept,
          bug13_historyPushed,
          bug14_ddDecoupledRiskDecision
        };
      })()`
    })).result.value;

    const fullSnapshot = Object.assign({ capturedAt: new Date().toISOString(), baseCommit: "413f04f", worker_hasQuotaLimiterDO }, checks);
    const outPath = path.join(ROOT, "tests/artifacts/pre-fix-red-baseline.json");
    if (!fs.existsSync(outPath)) {
      fs.mkdirSync(path.join(ROOT, "tests/artifacts"), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(fullSnapshot, null, 2));
    } else {
      fs.writeFileSync(path.join(ROOT, "tests/artifacts/post-fix-green-verification.json"), JSON.stringify(fullSnapshot, null, 2));
    }
    console.log(JSON.stringify(fullSnapshot, null, 2));
    ws.close();
  } finally {
    chrome.kill();
    srv.close();
  }
})();
