#!/usr/bin/env node
/**
 * Phase 2B Multi-Category Profiles, Signals, LinkedIn, ICP Decision Chain, Customs B/L & Weekly Funnel
 * Zero-Dependency Headless Chrome CDP Verification
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const CHROME = require("./_chrome.cjs").findChrome();

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
  console.log("=== Phase 2B Browser E2E Verification ===");
  const { srv, port } = await startServer();
  const baseUrl = `http://127.0.0.1:${port}/`;
  const profileDir = `/tmp/fg_phase2b_${Date.now()}_${process.pid}`;
  const { spawnChromeEphemeralCdp } = require("./_chrome.cjs");
  const { proc: chromeProc, cdpPort } = await spawnChromeEphemeralCdp({
    profileDir,
    url: "about:blank",
    windowSize: "1440,900",
  });

  let cdp = null;
  try {
    let targets = null;
    for (let i = 0; i < 40; i++) {
      try {
        const list = await fetchJson(`http://127.0.0.1:${cdpPort}/json/list`);
        targets = list.filter((t) => t.type === "page");
        if (targets.length) break;
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(targets && targets.length > 0, "Headless Chrome page opened");
    cdp = await connectCdpTarget(targets[0].webSocketDebuggerUrl);
    await cdp.send("Page.navigate", { url: baseUrl });

    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const ready = await cdp.evalJs(`Boolean(location.href.startsWith(${JSON.stringify(baseUrl)}) && window.FG_CORE && window.navigateTo && document.getElementById("globalProdProfile"))`);
        if (ready) break;
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 100));
    }
    await cdp.evalJs(`window._fgStoreReadyPromise || Promise.resolve()`);

    // 1. P2B-1: Global Product Profile selector syncs across 5 modules
    const profSync = await cdp.evalJs(`(() => {
      const sel = document.getElementById("globalProdProfile");
      sel.value = "cable_power";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return {
        lfCustom: document.getElementById("lfCustom").value,
        msKeyword: document.getElementById("msKeyword").value,
        csvWaProd: document.getElementById("csvWaProd").value,
        emProduct: document.getElementById("emProduct").value,
        qcProdName: document.getElementById("qcProdName").value
      };
    })()`);
    assert.ok(profSync.lfCustom.includes("power cable"), "Lead Finder synced to cable_power");
    assert.ok(profSync.msKeyword.includes("power cable"), "Map Scraper synced to cable_power");
    assert.ok(profSync.csvWaProd.includes("power cables"), "CSV WhatsApp product synced to cable_power");
    assert.equal(profSync.emProduct, "power cables");
    assert.ok(profSync.qcProdName.includes("Power Cables"), "Quote Calculator product synced to cable_power");
    console.log("[PASS] P2B-1: Global Product Profile selector syncs across Lead Finder, Map Scraper, CSV, Email Gen & Quote Calc");

    // 2. P2B-3a: ICP Buyer Job-Title LinkedIn & Web dorks in #lead-finder
    const icpCheck = await cdp.evalJs(`(() => {
      window.navigateTo("lead-finder");
      const roleSel = document.getElementById("lfRoleSel");
      roleSel.value = "epc_eng";
      roleSel.dispatchEvent(new Event("change", { bubbles: true }));
      const links = Array.from(document.querySelectorAll("#lfRoleBtns a")).map((a) => ({
        text: a.textContent.trim(),
        href: a.href
      }));
      return links;
    })()`);
    assert.equal(icpCheck.length, 2);
    assert.ok(icpCheck[0].href.includes("linkedin.com%2Fin%2F") && icpCheck[0].href.includes("EPC%20Manager"));
    console.log("[PASS] P2B-3a: ICP Buyer Job-Title LinkedIn & Web decision-maker dork links rendered");

    // 3. P2B-3d & P2B-2a: Customs / ImportYeti B/L CSV import -> 🚢 提单买家 badge -> 写信 auto-injects import signal icebreaker -> 存入客户
    const csvBlCheck = await cdp.evalJs(`(() => {
      window.navigateTo("csv-workbench");
      const csvInput = document.getElementById("csvPasteInput");
      csvInput.value = [
        "Consignee,Country,Email,Phone,Website,HS Code,Shipments,Last Arrival,Supplier",
        "Texas Gulf Piping Supply LLC,United States,purchasing@txgulfpiping-test.com,+1 713 555 0144,https://txgulfpiping-test.com,848180,18,2026-10,Ningbo Flow Industrial"
      ].join("\\n");
      document.getElementById("btnParseCsv").click();
      const rowText = document.getElementById("csvTbody").textContent;
      document.querySelector("#csvTbody button[data-csv-crm='0']").click();
      document.querySelector("#csvTbody button[data-csv-em='0']").click();
      return {
        rowText,
        emSignal: document.getElementById("emSignal").value,
        emSignalNote: document.getElementById("emSignalNote").value,
        emBody: document.getElementById("emBodyOut").textContent
      };
    })()`);
    assert.ok(csvBlCheck.rowText.includes("🚢 提单买家：HS 848180 · 18票提单 · 到港 2026-10"), "CSV workbench rendered Customs B/L buyer badge");
    assert.equal(csvBlCheck.emSignal, "import", "Clicking 写信 on B/L buyer auto-selected import signal");
    assert.ok(csvBlCheck.emSignalNote.includes("HS 848180"), "Signal note populated with B/L details");
    assert.ok(csvBlCheck.emBody.includes("regularly imports industrial equipment"), "Email body injected import-history icebreaker");
    console.log("[PASS] P2B-3d & P2B-2a: Customs B/L CSV columns -> 🚢 提单买家 badge -> import signal outreach verified");

    // 4. P2B-2b: LinkedIn <=280-char connection note + char badge + pure foreign copy guard
    const liCheck = await cdp.evalJs(`(() => {
      window._copiedLi = [];
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: (t) => {
            window._copiedLi.push(t);
            return Promise.resolve();
          }
        }
      });
      const emType = document.getElementById("emType");
      emType.value = "linkedin_conn";
      emType.dispatchEvent(new Event("change", { bubbles: true }));
      const badgeHidden = document.getElementById("emCharBadge").hidden;
      const badgeText = document.getElementById("emCharBadge").textContent;
      const subBtnHidden = document.getElementById("btnCopySub").hidden;
      document.getElementById("btnCopyAll").click();
      const copied = window._copiedLi[window._copiedLi.length - 1] || "";
      return { badgeHidden, badgeText, subBtnHidden, copied, len: copied.length };
    })()`);
    assert.equal(liCheck.badgeHidden, false, "LinkedIn character badge visible");
    assert.ok(liCheck.badgeText.includes("/ 280"), "LinkedIn character badge displays / 280 limit");
    assert.equal(liCheck.subBtnHidden, true, "Subject copy button hidden in LinkedIn mode");
    assert.ok(liCheck.len > 30 && liCheck.len <= 280, `LinkedIn note length within 280 chars (got ${liCheck.len})`);
    assert.ok(!liCheck.copied.includes("Subject:") && !/[\u4e00-\u9fff]/.test(liCheck.copied), "Copied LinkedIn note has zero Subject: or Chinese UI text");
    console.log(`[PASS] P2B-2b: LinkedIn connection note (${liCheck.len}/280 chars) & pure copy guard verified`);

    // 5. P2B-3b/c & P2B-4: CRM multi-contact chain, A/B/C inquiry clarification, lossReason & Home Weekly Funnel
    const crmAndFunnel = await cdp.evalJs(`(() => {
      const lead = window.addCustomerToCrm({
        company: "Andes Copper EPC S.A.",
        country: "Chile",
        email: "licitaciones@andescopper-test.cl",
        product: "power cables"
      });
      // Tab 1: Add secondary Engineering decision maker
      window.openClientDetail(lead.id, "info");
      document.getElementById("cdCtName").value = "Rodrigo Silva";
      document.getElementById("cdCtRole").value = "工程/技术总工";
      document.getElementById("cdCtEmail").value = "rodrigo.silva@andescopper-test.cl";
      document.querySelector('#crmDetailPanel button[data-cd-action="add-contact"]').click();
      const ctCount = lead.contacts.length;

      // Tab 4: Inquiry A/B/C Triage & Spanish clarification reply
      window.openClientDetail(lead.id, "email");
      const cbs = Array.from(document.querySelectorAll("#cdClarifyChecks input"));
      // Uncheck 2 items so only 1 missing -> Tier B!
      cbs.forEach((cb, idx) => { cb.checked = idx === 0; });
      cbs[0].dispatchEvent(new Event("change", { bubbles: true }));
      const tierTextB = document.getElementById("cdClarifyTier").textContent;
      const clarifyEs = document.getElementById("cdClarifyOut").textContent;

      // Tab 2: Mark lost lead with attribution reason for funnel check
      const lostLead = window.addCustomerToCrm({
        company: "Lost Sample Buyer Co.",
        country: "Peru",
        stage: "暂停/流失归档"
      });
      window.openClientDetail(lostLead.id, "follow");
      const lossSel = document.querySelector('#crmDetailPanel select[data-cd-f="lossReason"]');
      lossSel.value = "价格高于目标价";
      lossSel.dispatchEvent(new Event("change", { bubbles: true }));

      // Navigate to Home Workspace and check Weekly Funnel + mobile 390px layout
      window.navigateTo("home-workspace");
      const funnelText = document.getElementById("homeFunnelBody").textContent;
      return { ctCount, tierTextB, clarifyEs, savedTier: lead.inquiryTier, funnelText };
    })()`);
    assert.equal(crmAndFunnel.ctCount, 1, "Added secondary Engineering contact to CRM lead");
    assert.equal(crmAndFunnel.savedTier, "B", "Inquiry tier updated to B");
    assert.ok(crmAndFunnel.tierTextB.includes("B级待澄清询盘"), "Tier badge shows B级待澄清询盘");
    assert.ok(crmAndFunnel.clarifyEs.includes("Especificación técnica"), "Chile lead generated Spanish technical clarification reply");
    assert.ok(crmAndFunnel.funnelText.includes("在库活跃客户") && crmAndFunnel.funnelText.includes("价格高于目标价"), "Home Weekly Funnel displays active counts & top loss reason");
    console.log("[PASS] P2B-3b/c & P2B-4: Multi-contact chain, Spanish A/B/C inquiry triage & Home Weekly Funnel verified");

    // 6. Mobile 390x844 horizontal overflow check with new top bar & funnel card
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true
    });
    const mobileOverflow = await cdp.evalJs(`(() => {
      return document.documentElement.scrollWidth - document.documentElement.clientWidth;
    })()`);
    assert.ok(mobileOverflow <= 1, `Expected zero horizontal overflow at 390px mobile width, got +${mobileOverflow}px`);
    console.log("[PASS] P2B-Mobile: Zero horizontal overflow at 390x844 mobile viewport");

    assert.equal(cdp.pageErrors.length, 0, `Unexpected page errors: ${cdp.pageErrors.join("; ")}`);
    console.log("=== ALL PHASE 2B E2E CHECKS PASSED ===");
  } finally {
    if (cdp && cdp.ws) try { cdp.ws.close(); } catch (_) {}
    chromeProc.kill("SIGKILL");
    srv.close();
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (_) {}
  }
})();
