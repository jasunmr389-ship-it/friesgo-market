#!/usr/bin/env node
/**
 * FriesGo Global - Round 2 Cross-Audit Pre-Fix Red Baseline Reproducer
 * Reproduces all 9 newly identified P0/P1 issues BEFORE any Round 2 code changes:
 *   - Before Round 2 fixes (`a0a5ccc`): all 9 checks MUST evaluate to `false` (saved to `tests/artifacts/round2-pre-fix-red.json`).
 *   - After Round 2 fixes: all 9 checks MUST evaluate to `true` (saved to `tests/artifacts/round2-post-fix-green.json`).
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
        res.writeHead(404);
        res.end("404");
        return;
      }
      const mimes = {
        ".html": "text/html;charset=utf-8",
        ".js": "application/javascript;charset=utf-8",
        ".json": "application/json;charset=utf-8",
        ".css": "text/css;charset=utf-8",
        ".png": "image/png"
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
          try {
            res(JSON.parse(d));
          } catch (e) {
            rej(e);
          }
        });
      })
      .on("error", rej);
  });
}

async function attachPage(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let seq = 0;
  const pend = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m.result);
      pend.delete(m.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      pend.set(++seq, res);
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
    return r && r.result ? r.result.value : undefined;
  };
  return { ws, send, evalJs };
}

(async () => {
  const workerSrc = fs.readFileSync(path.join(ROOT, "workers/gmaps-proxy.js"), "utf8");
  const FG_CORE = require(path.join(ROOT, "js/fg-core.js"));

  // Pure check for P1-5: 5 units * 9t each on 26t container payload limit -> 3 units = 27t > 26t, so MUST need 3 containers (not 2)
  const ctn5x9 = FG_CORE.computeContainerLoad(
    [{ name: "9t主机", l: 220, w: 150, h: 180, kg: 9000, qty: 5 }],
    { routeMode: "std", packMode: "crate" }
  );
  const p1_5_ffdHeavyUnits5x9t = !!(ctn5x9 && ctn5x9.ok && /^3\s*×/.test(ctn5x9.rec));

  const { srv, port } = await startServer();
  const baseUrl = `http://127.0.0.1:${port}/`;
  const profileDir = `/tmp/fg_r2_red_${Date.now()}`;
  const { spawnChromeEphemeralCdp } = require("./_chrome.cjs");
  const { proc: chrome, cdpPort } = await spawnChromeEphemeralCdp({
    profileDir,
    url: baseUrl
  });

  try {
    let targets = null;
    for (let i = 0; i < 45; i++) {
      try {
        targets = await fetchJson(`http://127.0.0.1:${cdpPort}/json`);
        if (targets && targets.find((t) => t.type === "page")) break;
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 150));
    }
    const tabA = await attachPage(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r) => setTimeout(r, 1000));
    await tabA.evalJs(`window._fgStoreReadyPromise`);

    /* -----------------------------------------------------------------------
     * P0-1: Multi-tab concurrent save conflict & soft-delete resurrection test
     * ----------------------------------------------------------------------- */
    await tabA.evalJs(`(async () => {
      window.addCustomerToCrm({ id: "ld_conc_1", company: "Concurrent Valve Ltd", country: "Vietnam", phone: "+84901111111" });
      window.addCustomerToCrm({ id: "ld_conc_del", company: "Soon Deleted Co", country: "Chile" });
      await window._lastCrmSavePromise;
    })()`);

    const { targetId: tabBId } = await tabA.send("Target.createTarget", { url: baseUrl });
    const targets2 = await fetchJson(`http://127.0.0.1:${cdpPort}/json`);
    const tabB = await attachPage(targets2.find((t) => t.id === tabBId).webSocketDebuggerUrl);
    await new Promise((r) => setTimeout(r, 900));
    await tabB.evalJs(`window._fgStoreReadyPromise`);

    // Pause Tab B's remote reload briefly to simulate concurrent simultaneous edits before BroadcastChannel roundtrip
    await tabB.evalJs(`window._origReloadForTest = window.reloadCrmFromStore; window.reloadCrmFromStore = () => Promise.resolve();`);

    // Tab A appends timeline `tl_tabA` on ld_conc_1 AND soft-deletes ld_conc_del
    await tabA.evalJs(`(async () => {
      const l1 = crmLeads.find(x => x.id === "ld_conc_1");
      l1.timeline.unshift({ id: "tl_tabA", tlId: "tl_tabA", ts: "2026-11-26 10:01", channel: "电话", result: "TabA新增跟进" });
      l1.updatedAt = Date.now();
      saveLeadsLocal();
      await window._lastCrmSavePromise;

      const lDel = crmLeads.find(x => x.id === "ld_conc_del");
      crmLeads = crmLeads.filter(x => x.id !== "ld_conc_del");
      await moveLeadToTrash(lDel, "TabA删除客户");
    })()`);

    // Simultaneously, Tab B (with stale memory still holding ld_conc_del as active and ld_conc_1 without tl_tabA)
    // adds a quote version `qt_tabB` + updates phone on ld_conc_1 and saves!
    await tabB.evalJs(`(async () => {
      const l1 = crmLeads.find(x => x.id === "ld_conc_1");
      l1.phone = "+84909999999";
      l1.quotes.unshift({ quoteId: "qt_tabB", refNo: "FG-TEST-V1", savedAt: "2026-11-26 10:02", fobStr: "$12,000.00" });
      l1.updatedAt = Date.now() + 50;
      saveLeadsLocal();
      await window._lastCrmSavePromise;
      window.reloadCrmFromStore = window._origReloadForTest;
    })()`);

    const p0_1_multiTabConcurrentNoOverwrite = await tabA.evalJs(`(async () => {
      const st = await window.FG_STORE.loadState();
      const c1 = st.activeLeads.find(x => x.id === "ld_conc_1");
      const delStillInTrash = st.deletedLeads.some(x => x.id === "ld_conc_del") && !st.activeLeads.some(x => x.id === "ld_conc_del");
      const hasTabATl = !!(c1 && c1.timeline.some(t => t.tlId === "tl_tabA"));
      const hasTabBQt = !!(c1 && c1.quotes.some(q => q.quoteId === "qt_tabB"));
      return delStillInTrash && hasTabATl && hasTabBQt && c1.phone === "+84909999999";
    })()`);

    tabB.ws.close();
    await tabA.send("Target.closeTarget", { targetId: tabBId });

    /* -----------------------------------------------------------------------
     * Remaining P0 & P1 checks inside Tab A
     * ----------------------------------------------------------------------- */
    const restChecks = await tabA.evalJs(`(async () => {
      // P0-2: Full JSON backup payload + restore must include crmTrash AND complianceLogs, and snapshots must include complianceLogs
      await window.FG_STORE.saveComplianceLog({
        logId: "chk_r2_test",
        orderRef: "PI-2026-001",
        clientName: "Concurrent Valve Ltd",
        country: "Vietnam",
        productHs: "8481.80",
        reviewer: "Jasun",
        decision: "approved",
        savedAt: "2026-11-26 11:00"
      });
      await window.reloadCrmFromStore();

      const snap = await window.FG_STORE.createSnapshot("R2快照校验");
      const snapHasCompliance = Array.isArray(snap.complianceLogs) && snap.complianceLogs.length > 0;
      const hasBackupBuilder = typeof window.buildFullBackupPayload === "function" && typeof window.restoreFullBackupPayload === "function";
      let p0_2_fullBackupRestoreTrashAndCompliance = false;
      if (hasBackupBuilder && snapHasCompliance) {
        const payload = window.buildFullBackupPayload();
        const hasTrashInBackup = Array.isArray(payload.crmTrash) && payload.crmTrash.length > 0;
        const hasCompInBackup = Array.isArray(payload.complianceLogs) && payload.complianceLogs.length > 0;
        // Wipe DB and restore from payload
        await window.FG_STORE.wipeAllForTest && await window.FG_STORE.wipeAllForTest();
        await window.restoreFullBackupPayload(payload, { mode: "overwrite" });
        const afterRestore = await window.FG_STORE.loadState();
        p0_2_fullBackupRestoreTrashAndCompliance =
          hasTrashInBackup &&
          hasCompInBackup &&
          afterRestore.deletedLeads.length > 0 &&
          afterRestore.complianceLogs.some(c => c.logId === "chk_r2_test");
      }

      // P1-4: Indicative Quotation for unbound/pending client vs Formal Quotation ONLY for approved DD client
      navigateTo("quote-calc");
      const setVal = (id, v) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      setVal("qcBindClient", "");
      setVal("qcFactoryRmb", "50000");
      setVal("qcQty", "10");
      setVal("qcFx", "7.2");
      setVal("qcMargin", "20");
      document.getElementById("btnShowRfq").click();
      const unboundRfqTxt = (document.getElementById("rfqEmailOut") || {}).textContent || "";
      const p1_4_indicativeVsFormalQuotation =
        unboundRfqTxt.includes("Indicative Quotation") && !unboundRfqTxt.includes("Formal Quotation");

      // P1-6: Quote Ref device tag + IDB sequence + internal quoteId
      const stQuote = window._lastQuoteState || {};
      const p1_6_quoteRefDeviceTagAndIdbSeq = !!(
        stQuote.quoteId &&
        /^FG-\\d{8}-[A-Z0-9]+-[A-Z0-9]{4}-\\d{3}-V\\d+$/.test(stQuote.refNo || "")
      );

      // P1-7: Final post-rounding minimum profit floor check (#qcMinMarginFloor + belowProfitFloor warning/guard)
      const floorInput = document.getElementById("qcMinMarginFloor");
      let p1_7_postRoundingProfitFloorGuard = false;
      if (floorInput) {
        setVal("qcMinMarginFloor", "15");
        setVal("qcMargin", "8");
        p1_7_postRoundingProfitFloorGuard = !!(window._lastQuoteState && window._lastQuoteState.belowProfitFloor === true);
        setVal("qcMargin", "20");
      }

      // P1-8: Direct API key personal-billing warning UI
      navigateTo("map-scraper");
      const directWarnEl = document.getElementById("gmapsDirectBillingWarn");
      const p1_8_uiWarn = !!(directWarnEl && directWarnEl.textContent.includes("独立计费"));

      // P1-9: Order-level compliance (#pcOrderRef + #pcDecision decoupled from 6/6 checkboxes + high-risk End-User guard)
      navigateTo("precheck");
      const hasOrderRef = !!document.getElementById("pcOrderRef");
      const hasPcDecision = !!document.getElementById("pcDecision");
      document.querySelectorAll("#complianceChecklist input[type='checkbox']").forEach(cb => {
        cb.checked = true;
        cb.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const chkTxt = (document.getElementById("chkProgress") || {}).textContent || "";
      const p1_9_orderLevelComplianceDecoupled = !!(hasOrderRef && hasPcDecision && !chkTxt.includes("审核通过"));

      // P0-3: Corrupted legacy JSON in localStorage MUST NOT silently succeed & delete raw data!
      await new Promise((res) => {
        const req = indexedDB.deleteDatabase("friesgo_crm_db");
        req.onsuccess = () => res();
        req.onerror = () => res();
        req.onblocked = () => res();
      });
      localStorage.removeItem("friesgo_idb_migrated_v1");
      localStorage.removeItem("friesgo_schema_guard");
      localStorage.setItem("friesgo_leads_v2", "{corrupt_broken_json:[");
      // Force fresh DB open attempt
      if (window.FG_STORE._resetForTest) window.FG_STORE._resetForTest();
      let migrationRejected = false;
      try {
        await window.FG_STORE.init({ cnMap: CN });
      } catch (e) {
        migrationRejected = true;
      }
      const rawStillIntact = localStorage.getItem("friesgo_leads_v2") === "{corrupt_broken_json:[";
      const p0_3_corruptJsonMigrationAbortsSafely = migrationRejected && rawStillIntact;

      return {
        p0_2_fullBackupRestoreTrashAndCompliance,
        p0_3_corruptJsonMigrationAbortsSafely,
        p1_4_indicativeVsFormalQuotation,
        p1_6_quoteRefDeviceTagAndIdbSeq,
        p1_7_postRoundingProfitFloorGuard,
        p1_8_uiWarn,
        p1_9_orderLevelComplianceDecoupled
      };
    })()`);

    const workerBlocksProdBypass = /ENVIRONMENT.*production/i.test(workerSrc) && /X-Quota-Mode/i.test(workerSrc);
    const p1_8_gmapsDirectKeyBillingWarnAndProdGuard = !!(restChecks.p1_8_uiWarn && workerBlocksProdBypass);

    const snapshot = {
      capturedAt: new Date().toISOString(),
      baseCommit: "a0a5ccc",
      p0_1_multiTabConcurrentNoOverwrite,
      p0_2_fullBackupRestoreTrashAndCompliance: restChecks.p0_2_fullBackupRestoreTrashAndCompliance,
      p0_3_corruptJsonMigrationAbortsSafely: restChecks.p0_3_corruptJsonMigrationAbortsSafely,
      p1_4_indicativeVsFormalQuotation: restChecks.p1_4_indicativeVsFormalQuotation,
      p1_5_ffdHeavyUnits5x9t,
      p1_6_quoteRefDeviceTagAndIdbSeq: restChecks.p1_6_quoteRefDeviceTagAndIdbSeq,
      p1_7_postRoundingProfitFloorGuard: restChecks.p1_7_postRoundingProfitFloorGuard,
      p1_8_gmapsDirectKeyBillingWarnAndProdGuard,
      p1_9_orderLevelComplianceDecoupled: restChecks.p1_9_orderLevelComplianceDecoupled
    };

    fs.mkdirSync(path.join(ROOT, "tests/artifacts"), { recursive: true });
    const prePath = path.join(ROOT, "tests/artifacts/round2-pre-fix-red.json");
    if (!fs.existsSync(prePath)) {
      fs.writeFileSync(prePath, JSON.stringify(snapshot, null, 2));
    } else {
      fs.writeFileSync(path.join(ROOT, "tests/artifacts/round2-post-fix-green.json"), JSON.stringify(snapshot, null, 2));
    }
    console.log(JSON.stringify(snapshot, null, 2));
    tabA.ws.close();
  } finally {
    chrome.kill();
    srv.close();
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch (_) {}
  }
})();
