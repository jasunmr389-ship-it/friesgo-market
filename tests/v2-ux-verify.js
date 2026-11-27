#!/usr/bin/env node
/**
 * V2.0 UX Simplification, Foreign-Trade Timing/Holiday/60Hz Guardrails,
 * Progressive Disclosure, Split-Pane CRM & Email, Smart Paste & Cmd+K Verification
 * Zero-Dependency Headless Chrome CDP Verification across 1440px / 1280px / 1024px / 390px
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
  return { ws, send, evalJs, pageErrors };
}

(async () => {
  const { srv, port } = await startServer();
  const baseUrl = `http://127.0.0.1:${port}/`;
  const userDir = `/tmp/fg-v2-ux-verify-${Date.now()}`;
  const debugPort = 9460 + Math.floor(Math.random() * 200);
  const chrome = spawn(CHROME, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${userDir}`,
    `--remote-debugging-port=${debugPort}`,
    "about:blank"
  ]);

  try {
    let targets = null;
    for (let i = 0; i < 40; i++) {
      try {
        targets = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`);
        if (targets && targets.some((t) => t.type === "page")) break;
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 150));
    }
    const pageTarget = targets.find((t) => t.type === "page");
    assert.ok(pageTarget, "Chrome page target not found");
    const cdp = await connectCdpTarget(pageTarget.webSocketDebuggerUrl);
    await cdp.send("Page.navigate", { url: baseUrl });

    for (let i = 0; i < 40; i++) {
      const ready = await cdp.evalJs(`Boolean(window.FG_STORE && window.FG_CORE && document.getElementById("homeKpiToday"))`);
      if (ready) break;
      await new Promise((r) => setTimeout(r, 150));
    }

    // 1. Topbar Quick Search (Cmd/Ctrl+K), Pinning & Home Dual-Track Holiday Alert + Wave Filter
    const homeRes = await cdp.evalJs(`(function(){
      var alertBar = document.getElementById("homeTradeAlertBar");
      var alertVisible = alertBar && !alertBar.hidden && alertBar.textContent.length > 10;
      navigateTo("quote-calc");
      var pinBtn = document.getElementById("btnPinCurrentTool");
      pinBtn.click();
      var pinnedTxt = pinBtn.textContent;
      var qs = document.getElementById("globalQuickSearch");
      qs.value = "墨西哥";
      qs.dispatchEvent(new Event("input", { bubbles: true }));
      var drop = document.getElementById("globalQuickDrop");
      var dropVisible = !drop.hidden && drop.textContent.includes("墨西哥");
      drop.hidden = true;
      return { alertVisible: alertVisible, pinnedTxt: pinnedTxt, dropVisible: dropVisible };
    })()`);
    assert.equal(homeRes.alertVisible, true, "Home dual-track holiday/Spring Festival alert bar should render");
    assert.ok(homeRes.pinnedTxt.includes("已收藏"), "Tool pinning button should toggle to 已收藏");
    assert.equal(homeRes.dropVisible, true, "Global quick search should find countries/tools/clients");
    console.log("  ✓ [1/6] Topbar Quick Search, Tool Pinning & Home 60-Day Trade Holiday Alert verified");

    // 2. Smart Paste in Due Diligence + Active Client Context Bar carry-over
    const ddRes = await cdp.evalJs(`(function(){
      navigateTo("duediligence");
      var inp = document.getElementById("ddSmartPasteInp");
      inp.value = "Ing. Carlos Mendez | Purchasing Manager | Acero Monterrey S.A. de C.V. | cmendez@acero.mx | +52 81 8345 6789 | https://www.acero.mx";
      document.getElementById("btnDdSmartPaste").click();
      return {
        comp: document.getElementById("ddCompany").value,
        dom: document.getElementById("ddDomain").value,
        em: document.getElementById("ddEmail").value,
        ctry: document.getElementById("ddCountry").value,
        acHidden: document.getElementById("activeClientBar").hidden,
        acText: document.getElementById("activeClientInfo").textContent
      };
    })()`);
    assert.equal(ddRes.comp, "Acero Monterrey S.A. de C.V.");
    assert.equal(ddRes.dom, "acero.mx");
    assert.equal(ddRes.em, "cmendez@acero.mx");
    assert.equal(ddRes.ctry, "Mexico");
    assert.equal(ddRes.acHidden, false, "Active Client Context Bar should appear automatically");
    assert.ok(ddRes.acText.includes("Acero Monterrey") && ddRes.acText.includes("60Hz"), `Expected Active Client bar with 60Hz info, got: ${ddRes.acText}`);
    console.log("  ✓ [2/6] Smart Business Card Paste in Due Diligence & Active Client Context Bar verified");

    // 3. Progressive Disclosure in #quote-calc (collapsed drawer, 60Hz guardrail, conservative math intact)
    const qcRes = await cdp.evalJs(`(function(){
      document.querySelector('#activeClientBar button[data-ac-act="quote"]').click();
      var drawer = document.getElementById("qcAdvParamsDrawer");
      var specTxt = document.getElementById("qcSpecGuardBar").textContent;
      var pillTxt = document.getElementById("qcAdvSummaryPill").textContent;
      var fobTxt = document.getElementById("qcFobOut").textContent;
      return {
        drawerCollapsedByDefault: !drawer.open,
        specTxt: specTxt,
        pillTxt: pillTxt,
        fobTxt: fobTxt,
        country: document.getElementById("qcCountry").value
      };
    })()`);
    assert.equal(qcRes.drawerCollapsedByDefault, true, "Quote advanced parameter drawer must be collapsed by default");
    assert.equal(qcRes.country, "Mexico", "Active Client Bar '去报价' must carry Mexico into Quote Calculator");
    assert.ok(qcRes.specTxt.includes("60Hz") && qcRes.specTxt.includes("NOM"), `Expected 60Hz + NOM alert for Mexico, got: ${qcRes.specTxt}`);
    assert.ok(qcRes.pillTxt.includes("0%退税") && qcRes.pillTxt.includes("利润红线"), `Expected live summary pill, got: ${qcRes.pillTxt}`);
    assert.ok(qcRes.fobTxt.startsWith("$"), `Quote FOB output must compute cleanly when drawer is collapsed, got: ${qcRes.fobTxt}`);
    console.log("  ✓ [3/6] Progressive Disclosure Quote Calculator + 60Hz/NOM Guardrail verified");

    // 4. Split-Pane #email-gen (world-clock decoupled to innerTab, timing bar, spam check, soft opt-out)
    const emRes = await cdp.evalJs(`(function(){
      document.querySelector('#activeClientBar button[data-ac-act="email"]').click();
      var wcActiveInEmail = document.getElementById("world-clock").classList.contains("fg-active");
      var tmTxt = document.getElementById("emTradeTimingBar").textContent;
      var spmTxt = document.getElementById("emSpamCheckBar").textContent;
      var softCb = document.getElementById("emSoftOptOutCb");
      softCb.checked = true;
      softCb.dispatchEvent(new Event("change", { bubbles: true }));
      var bodyWithOpt = document.getElementById("emBodyOut").textContent;
      // Verify world-clock is still routable via innerTab!
      navigateTo("world-clock");
      var wcRoutable = document.getElementById("world-clock").classList.contains("fg-active");
      navigateTo("email-gen");
      return {
        wcActiveInEmail: wcActiveInEmail,
        wcRoutable: wcRoutable,
        tmTxt: tmTxt,
        spmTxt: spmTxt,
        bodyWithOpt: bodyWithOpt
      };
    })()`);
    assert.equal(emRes.wcActiveInEmail, false, "#world-clock must NOT clutter the top of #email-gen");
    assert.equal(emRes.wcRoutable, true, "#world-clock must remain 100% routable via innerTab");
    assert.ok(emRes.tmTxt.includes("60Hz") && emRes.tmTxt.includes("NOM"), `Expected timing + 60Hz bar in email-gen, got: ${emRes.tmTxt}`);
    assert.ok(emRes.spmTxt.includes("反垃圾健康度") || emRes.spmTxt.includes("送达率"), `Expected spam check bar, got: ${emRes.spmTxt}`);
    assert.ok(emRes.bodyWithOpt.includes("PD:") || emRes.bodyWithOpt.includes("P.S."), "Soft opt-out checkbox must append localized polite opt-out");
    console.log("  ✓ [4/6] Split-Pane Email Generator + Timing/60Hz Bar + Spam Check + Soft Opt-out verified");

    // 5. CRM Smart Paste + Side-by-Side Split-Pane + Prev/Next Client Queue + Saudi Friday Skipping
    const crmRes = await cdp.evalJs(`(function(){
      navigateTo("client-list");
      document.getElementById("btnToggleAddClient").click();
      document.getElementById("crmSmartPasteInp").value = "Eng. Ahmed Al-Qahtani | Procurement Director | Dammam Piping Co. | ahmed@dammampiping.sa | +966 13 882 4400 | www.dammampiping.sa";
      document.getElementById("btnCrmSmartPaste").click();
      document.getElementById("btnCrmAdd").click();

      // Add a second client so queue switcher has 2 clients
      window.addCustomerToCrm({
        company: "Saigon Industrial Valve JSC",
        country: "Vietnam",
        email: "buyer@saigonvalve.vn",
        phone: "0903888999"
      });
      window.openClientDetail(window._lastCrmFilteredIds[0], "info");
      var splitWrap = document.getElementById("crmSplitWrap");
      var hasSplit = splitWrap.classList.contains("has-detail");
      var gridCols1440 = getComputedStyle(splitWrap).gridTemplateColumns.split(" ").length;
      var firstComp = document.querySelector("#crmDetailPanel .crm-detail-head b").textContent;
      var nextBtn = document.querySelector('#crmDetailPanel button[data-cd-nav="next"]');
      nextBtn.click();
      var secondComp = document.querySelector("#crmDetailPanel .crm-detail-head b").textContent;
      return {
        hasSplit: hasSplit,
        gridCols1440: gridCols1440,
        firstComp: firstComp,
        secondComp: secondComp
      };
    })()`);
    assert.equal(crmRes.hasSplit, true, "#crmSplitWrap must gain .has-detail when a client is open");
    assert.equal(crmRes.gridCols1440, 2, "At 1440px desktop width, CRM master-detail must render 2 side-by-side columns");
    assert.notEqual(crmRes.firstComp, crmRes.secondComp, "Clicking '下一家 →' must switch to the next client in queue without closing detail");
    console.log("  ✓ [5/6] CRM Smart Paste + 1440px Side-by-Side Split-Pane + Prev/Next Queue verified");

    // 6. Multi-Viewport Zero Overflow Audit (1440px, 1280px, 1024px, 390px) + CSV WhatsApp Traffic Light
    await cdp.evalJs(`(function(){
      navigateTo("csv-workbench");
      document.getElementById("btnLoadSampleCsv").click();
    })()`);
    const csvWaTxt = await cdp.evalJs(`document.getElementById("csvTbody").textContent`);
    assert.ok(/[🟢🟡🔴]/.test(csvWaTxt), "CSV Workbench WhatsApp pills must display real-time country timing traffic light dots");

    const viewports = [
      { w: 1440, h: 900, mobile: false },
      { w: 1280, h: 800, mobile: false },
      { w: 1024, h: 768, mobile: false },
      { w: 390, h: 844, mobile: true }
    ];
    for (const vp of viewports) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: vp.w,
        height: vp.h,
        deviceScaleFactor: vp.mobile ? 2 : 1,
        mobile: vp.mobile
      });
      for (const toolId of ["home-workspace", "email-gen", "quote-calc", "client-list", "csv-workbench"]) {
        const ov = await cdp.evalJs(`(function(){
          navigateTo(${JSON.stringify(toolId)});
          return document.documentElement.scrollWidth - window.innerWidth;
        })()`);
        assert.ok(ov <= 1, `Horizontal overflow ${ov}px detected on ${toolId} at viewport ${vp.w}x${vp.h}`);
      }
    }
    console.log("  ✓ [6/6] Multi-viewport layout audit (1440px / 1280px / 1024px / 390px) & CSV WhatsApp traffic light passed with 0px overflow");

    assert.equal(cdp.pageErrors.length, 0, "Unexpected runtime page errors: " + cdp.pageErrors.join("; "));
    console.log("\nALL V2.0 UX & FOREIGN-TRADE TIMING VERIFICATION CHECKS PASSED!");
    cdp.ws.close();
  } finally {
    chrome.kill("SIGKILL");
    srv.close();
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (_) {}
  }
})().catch((err) => {
  console.error("V2.0 verification failed:", err);
  process.exit(1);
});
