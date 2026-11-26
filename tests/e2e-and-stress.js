#!/usr/bin/env node
/**
 * FriesGo Global - Phase 1 Comprehensive Headless Chrome E2E, Failure-Injection & 10k Stress Suite (T10)
 * Verifies:
 *   1. Zero uncaught JS/console errors across all workspaces, tools, inner tabs + popstate Back/Forward
 *   2. Legacy localStorage -> IndexedDB idempotent lossless migration + backup preservation + no dual-write
 *   3. IndexedDB failure injection (_simulateFailure = true) -> UI shows ⚠️ 未保存 & warning banner (no false save)
 *   4. Pre-destructive transactional snapshot + 1-click rollback
 *   5. Lossless stable-ID JSON merge restore (tlId + quoteId union)
 *   6. Multi-tab BroadcastChannel live sync across two concurrent Chrome tabs
 *   7. Quote DD Gate (unbound warning vs blocked/review hard-lock vs approved unlock)
 *   8. Order-bound 6-step #precheck compliance archive + client-switch reset + reload persistence
 *   9. Performance Stress: 10,000 CRM leads (sync, render, search, un-truncated soft-delete, snapshot rollback) & 5,000 CSV rows
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
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
        ".png": "image/png",
        ".svg": "image/svg+xml"
      };
      res.writeHead(200, { "Content-Type": mimes[path.extname(fp)] || "text/plain" });
      res.end(fs.readFileSync(fp));
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
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
    } else if (m.method === "Runtime.consoleAPICalled" && m.params && m.params.type === "error") {
      const txt = (m.params.args || []).map((a) => a.value || a.description || "").join(" ");
      // Ignore intentional simulated storage failure logs if any
      if (!/Simulated IndexedDB/i.test(txt)) {
        pageErrors.push("console.error: " + txt);
      }
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

async function fetchJson(url) {
  return JSON.parse(
    await new Promise((res, rej) => {
      http
        .get(url, (r) => {
          let d = "";
          r.on("data", (c) => (d += c));
          r.on("end", () => res(d));
        })
        .on("error", rej);
    })
  );
}

(async () => {
  const { srv, port } = await startServer();
  const baseUrl = `http://127.0.0.1:${port}/`;
  const cdpPort = 9369;
  const profileDir = `/tmp/fg_e2e_stress_${Date.now()}`;
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profileDir}`,
      baseUrl
    ],
    { stdio: "ignore" }
  );

  const report = {
    executedAt: new Date().toISOString(),
    results: {},
    timingsMs: {},
    pageErrors: []
  };

  try {
    let targets = null;
    for (let i = 0; i < 50; i++) {
      try {
        targets = await fetchJson(`http://127.0.0.1:${cdpPort}/json`);
        if (targets && targets.find((t) => t.type === "page")) break;
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 150));
    }
    const pageTarget = targets.find((t) => t.type === "page");
    assert.ok(pageTarget, "Chrome page target must launch");

    const tab1 = await connectCdpTarget(pageTarget.webSocketDebuggerUrl);
    await new Promise((r) => setTimeout(r, 1200));
    await tab1.evalJs(`window._fgStoreReadyPromise`);

    /* =========================================================================
     * 1. All Workspaces, Tools, Inner Tabs + Router Back/Forward (popstate)
     * ========================================================================= */
    console.log("▶ [1/9] Verifying zero errors across all workspaces/tools & popstate Back/Forward...");
    const navRes = await tab1.evalJs(`(async () => {
      const visited = [];
      const allKeys = [
        "home-workspace", "map-scraper", "lead-finder", "radar-live",
        "csv-workbench", "email-tools", "project-hunt", "radar-money",
        "radar-jobs", "radar-weather", "radar-expos", "radar-agents",
        "client-list", "duediligence", "email-gen", "objections",
        "quote-calc", "fx-converter", "container-calc", "hs-ref", "bundles",
        "market-table", "compare-panel", "actions", "precheck", "compliance",
        "ytd2026", "matrix", "china", "suppliers", "scope", "market30", "sources"
      ];
      for (const k of allKeys) {
        navigateTo(k);
        visited.push(location.hash);
      }
      // Test Browser Back & Forward via history.back() / history.forward()
      navigateTo("market-table");
      navigateTo("quote-calc");
      const hashAtQuote = location.hash;
      history.back();
      await new Promise(r => setTimeout(r, 120));
      const hashAfterBack = location.hash;
      const activeAfterBack = document.getElementById("panel-market").classList.contains("fg-active");
      history.forward();
      await new Promise(r => setTimeout(r, 120));
      const hashAfterFwd = location.hash;
      const activeAfterFwd = document.getElementById("quote-calc").classList.contains("fg-active");
      return { visitedCount: visited.length, hashAtQuote, hashAfterBack, activeAfterBack, hashAfterFwd, activeAfterFwd };
    })()`);
    assert.strictEqual(navRes.hashAtQuote, "#quote-calc");
    assert.strictEqual(navRes.hashAfterBack, "#market-table");
    assert.strictEqual(navRes.activeAfterBack, true);
    assert.strictEqual(navRes.hashAfterFwd, "#quote-calc");
    assert.strictEqual(navRes.activeAfterFwd, true);
    assert.strictEqual(tab1.pageErrors.length, 0, "Zero runtime/console errors across all tabs: " + tab1.pageErrors.join("; "));
    report.results.navigationAndPopstate = { pass: true, ...navRes };

    /* =========================================================================
     * 2. Legacy localStorage -> IndexedDB Idempotent Lossless Migration
     * ========================================================================= */
    console.log("▶ [2/9] Verifying legacy localStorage -> IndexedDB migration & backup preservation...");
    await tab1.evalJs(`(async () => {
      // Reset IndexedDB to simulate pre-Phase-1 browser state with legacy localStorage data
      await new Promise((res) => {
        const req = indexedDB.deleteDatabase("friesgo_crm_db");
        req.onsuccess = () => res();
        req.onerror = () => res();
        req.onblocked = () => res();
      });
      localStorage.removeItem("friesgo_idb_migrated_v1");
      localStorage.removeItem("friesgo_schema_guard");
      localStorage.removeItem("friesgo_leads_v2_backup_pre_p1");

      const legacyActive = [
        {
          id: "ld_leg_1",
          company: "Saigon Industrial Valve JSC",
          country: "Vietnam",
          email: "buyer@saigonvalve.vn",
          phone: "0903899112",
          stage: "已报价",
          timeline: [{ at: "2026-11-20 10:00", channel: "邮件", result: "发送首次报价单" }],
          quotes: [{ refNo: "FG-20261120-SAIGON-001-V1", savedAt: "2026-11-20 10:05", fobStr: "$18,500.00" }],
          updatedAt: 1795000001000
        },
        {
          id: "ld_leg_2",
          company: "Monterrey Steel S.A.",
          country: "Mexico",
          email: "compras@monterreysteel.mx",
          stage: "重点跟进",
          timeline: [{ at: "2026-11-21 09:00", channel: "WhatsApp", result: "确认图纸规格" }],
          quotes: [],
          updatedAt: 1795000002000
        },
        {
          id: "ld_leg_3",
          company: "Dammam Fluid Systems",
          country: "Saudi Arabia",
          stage: "有询盘",
          timeline: [],
          quotes: [],
          updatedAt: 1795000003000
        }
      ];
      const legacyTrash = [
        { deletedAt: 1794900000000, deletedAtStr: "2026-11-19 15:00", deletedBy: "Jasun", deleteReason: "旧版移入", lead: { id: "ld_del_1", company: "Archived Lead One", country: "Chile" } },
        { deletedAt: 1794900050000, deletedAtStr: "2026-11-19 15:10", deletedBy: "Jasun", deleteReason: "旧版移入", lead: { id: "ld_del_2", company: "Archived Lead Two", country: "Peru" } }
      ];
      localStorage.setItem("friesgo_leads_v2", JSON.stringify(legacyActive));
      localStorage.setItem("friesgo_trash_v1", JSON.stringify(legacyTrash));
    })()`);

    await tab1.send("Page.reload");
    await new Promise((r) => setTimeout(r, 1200));
    const migRes1 = await tab1.evalJs(`(async () => {
      await window._fgStoreReadyPromise;
      const st = await window.FG_STORE.loadState();
      return {
        activeCount: st.activeLeads.length,
        deletedCount: st.deletedLeads.length,
        memActive: crmLeads.length,
        memTrash: crmTrash.length,
        rawV2Removed: localStorage.getItem("friesgo_leads_v2") === null,
        rawTrashRemoved: localStorage.getItem("friesgo_trash_v1") === null,
        backupPreserved: !!localStorage.getItem("friesgo_leads_v2_backup_pre_p1"),
        saigonQuotes: (st.activeLeads.find(x => x.id === "ld_leg_1") || { quotes: [] }).quotes.length
      };
    })()`);
    assert.strictEqual(migRes1.activeCount, 3);
    assert.strictEqual(migRes1.deletedCount, 2);
    assert.strictEqual(migRes1.memActive, 3);
    assert.strictEqual(migRes1.memTrash, 2);
    assert.strictEqual(migRes1.rawV2Removed, true);
    assert.strictEqual(migRes1.rawTrashRemoved, true);
    assert.strictEqual(migRes1.backupPreserved, true);
    assert.strictEqual(migRes1.saigonQuotes, 1);

    // Reload a second time to prove idempotency
    await tab1.send("Page.reload");
    await new Promise((r) => setTimeout(r, 1000));
    const migRes2 = await tab1.evalJs(`(async () => {
      await window._fgStoreReadyPromise;
      const st = await window.FG_STORE.loadState();
      return { activeCount: st.activeLeads.length, deletedCount: st.deletedLeads.length };
    })()`);
    assert.strictEqual(migRes2.activeCount, 3);
    assert.strictEqual(migRes2.deletedCount, 2);
    report.results.legacyMigrationAndIdempotency = { pass: true, ...migRes1 };

    /* =========================================================================
     * 3. IndexedDB Failure Injection (_simulateFailure = true)
     * ========================================================================= */
    console.log("▶ [3/9] Verifying IndexedDB failure injection (honest error UI, no false save)...");
    const failInjRes = await tab1.evalJs(`(async () => {
      navigateTo("client-list");
      window.FG_STORE._simulateFailure = true;
      window.addCustomerToCrm({ company: "Unsaved Simulated Co", country: "Brazil" });
      try { await window._lastCrmSavePromise; } catch (_) {}
      await new Promise(r => setTimeout(r, 80));
      const statusDuringFail = document.getElementById("crmSaveStatus").textContent;
      const bannerShownDuringFail = !document.getElementById("storageWarnBanner").hidden;

      // Recover storage and verify clean persistence
      window.FG_STORE._simulateFailure = false;
      saveLeadsLocal();
      await window._lastCrmSavePromise;
      await new Promise(r => setTimeout(r, 80));
      const statusAfterRecover = document.getElementById("crmSaveStatus").textContent;
      const bannerHiddenAfterRecover = document.getElementById("storageWarnBanner").hidden;
      const idbLeads = await window.FG_STORE.getAllLeads();
      return {
        statusDuringFail,
        bannerShownDuringFail,
        statusAfterRecover,
        bannerHiddenAfterRecover,
        persistedCount: idbLeads.length
      };
    })()`);
    assert.ok(failInjRes.statusDuringFail.includes("未保存"), "Must show 未保存 on IDB write failure");
    assert.strictEqual(failInjRes.bannerShownDuringFail, true, "Warning banner must unhide on IDB failure");
    assert.ok(failInjRes.statusAfterRecover.includes("已写入本地库"), "Must show 已写入本地库 after recovery");
    assert.strictEqual(failInjRes.bannerHiddenAfterRecover, true);
    assert.strictEqual(failInjRes.persistedCount, 4);
    report.results.idbFailureInjection = { pass: true, ...failInjRes };

    /* =========================================================================
     * 4. Pre-Destructive Snapshot + 1-Click Rollback
     * ========================================================================= */
    console.log("▶ [4/9] Verifying transactional pre-destructive snapshot & 1-click rollback...");
    const snapRes = await tab1.evalJs(`(async () => {
      const origConfirm = window.confirm;
      window.confirm = () => true;
      document.getElementById("btnClearFollow").click();
      await new Promise(r => setTimeout(r, 250));
      const afterClear = await window.FG_STORE.loadState();
      const snapId = afterClear.snapshots[0] && afterClear.snapshots[0].snapId;

      // Open snapshot panel and click 1-click rollback button
      document.getElementById("btnToggleSnap").click();
      await new Promise(r => setTimeout(r, 50));
      const rbBtn = document.querySelector('[data-snap-restore="' + snapId + '"]');
      rbBtn.click();
      await new Promise(r => setTimeout(r, 250));
      window.confirm = origConfirm;
      const afterRollback = await window.FG_STORE.loadState();
      return {
        activeAfterClear: afterClear.activeLeads.length,
        trashAfterClear: afterClear.deletedLeads.length,
        snapCreated: !!snapId,
        activeAfterRollback: afterRollback.activeLeads.length,
        trashAfterRollback: afterRollback.deletedLeads.length
      };
    })()`);
    assert.strictEqual(snapRes.activeAfterClear, 0);
    assert.strictEqual(snapRes.trashAfterClear, 6); // 4 active moved + 2 prior trash
    assert.strictEqual(snapRes.snapCreated, true);
    assert.strictEqual(snapRes.activeAfterRollback, 4);
    assert.strictEqual(snapRes.trashAfterRollback, 2);
    report.results.snapshotAndRollback = { pass: true, ...snapRes };

    /* =========================================================================
     * 5. Lossless Stable-ID JSON Merge Restore (tlId + quoteId union)
     * ========================================================================= */
    console.log("▶ [5/9] Verifying lossless stable-ID merge restore across divergent backups...");
    const mergeRes = await tab1.evalJs(`(async () => {
      const incoming = [
        {
          id: "ld_leg_1",
          company: "Saigon Industrial Valve JSC",
          country: "Vietnam",
          contact: "Mr. Nguyen Procurement",
          timeline: [
            { tlId: "tl_remote_branch_b", ts: "2026-11-25 14:00", channel: "电话", result: "确认 L/C 审单条款" }
          ],
          quotes: [
            { quoteId: "qt_remote_v2", refNo: "FG-20261125-SAIGON-002-V2", savedAt: "2026-11-25 14:30", fobStr: "$17,900.00" }
          ],
          updatedAt: Date.now() + 5000
        },
        {
          id: "ld_brand_new_merge",
          company: "Jakarta Pump Engineering PT",
          country: "Indonesia",
          timeline: [{ tlId: "tl_jkt_1", ts: "2026-11-25 16:00", result: "新建询盘" }],
          quotes: [],
          updatedAt: Date.now() + 6000
        }
      ];
      const r = await window.FG_STORE.mergeImportLeads(incoming);
      await window.reloadCrmFromStore();
      const saigon = crmLeads.find(x => x.id === "ld_leg_1");
      return {
        added: r.added,
        merged: r.merged,
        totalActive: crmLeads.length,
        saigonContact: saigon.contact,
        saigonEmailPreserved: saigon.email,
        saigonTimelines: saigon.timeline.length,
        saigonQuotes: saigon.quotes.length
      };
    })()`);
    assert.strictEqual(mergeRes.added, 1);
    assert.strictEqual(mergeRes.merged, 1);
    assert.strictEqual(mergeRes.totalActive, 5);
    assert.strictEqual(mergeRes.saigonContact, "Mr. Nguyen Procurement");
    assert.strictEqual(mergeRes.saigonEmailPreserved, "buyer@saigonvalve.vn");
    assert.strictEqual(mergeRes.saigonTimelines, 2, "Both local legacy timeline and remote branch timeline preserved");
    assert.strictEqual(mergeRes.saigonQuotes, 2, "Both V1 and V2 quotes preserved");
    report.results.losslessMergeRestore = { pass: true, ...mergeRes };

    /* =========================================================================
     * 6. Multi-Tab BroadcastChannel Live Sync
     * ========================================================================= */
    console.log("▶ [6/9] Verifying multi-tab BroadcastChannel live sync...");
    const { targetId: tab2TargetId } = await tab1.send("Target.createTarget", { url: baseUrl });
    let targetsAfter = await fetchJson(`http://127.0.0.1:${cdpPort}/json`);
    const tab2Meta = targetsAfter.find((t) => t.id === tab2TargetId);
    assert.ok(tab2Meta, "Second tab target must attach");
    const tab2 = await connectCdpTarget(tab2Meta.webSocketDebuggerUrl);
    await new Promise((r) => setTimeout(r, 1000));
    await tab2.evalJs(`window._fgStoreReadyPromise`);

    const countTab2Before = await tab2.evalJs(`crmLeads.length`);
    await tab1.evalJs(`(async () => {
      window.addCustomerToCrm({ id: "ld_bcast_live", company: "Broadcast Synced Steel Ltd", country: "Poland" });
      await window._lastCrmSavePromise;
    })()`);
    await new Promise((r) => setTimeout(r, 350));
    const tab2SyncRes = await tab2.evalJs(`({
      countAfter: crmLeads.length,
      hasSyncedLead: crmLeads.some(x => x.id === "ld_bcast_live")
    })`);
    assert.strictEqual(countTab2Before, 5);
    assert.strictEqual(tab2SyncRes.countAfter, 6);
    assert.strictEqual(tab2SyncRes.hasSyncedLead, true);
    tab2.ws.close();
    await tab1.send("Target.closeTarget", { targetId: tab2TargetId });
    report.results.multiTabBroadcastSync = { pass: true, countTab2Before, ...tab2SyncRes };

    /* =========================================================================
     * 7. Quote DD Gate End-to-End (Unbound -> Blocked -> Review -> Approved)
     * ========================================================================= */
    console.log("▶ [7/9] Verifying Quote DD Gate (unbound warn vs blocked/review hard-lock vs approved)...");
    const ddGateRes = await tab1.evalJs(`(async () => {
      navigateTo("quote-calc");
      const setVal = (id, v) => {
        const el = document.getElementById(id);
        el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      setVal("qcFactoryRmb", "50000");
      setVal("qcQty", "10");
      setVal("qcFx", "7.2");
      setVal("qcMargin", "18");

      // A. Unbound client -> yellow warning, buttons enabled
      setVal("qcBindClient", "");
      const unboundLocked = document.getElementById("btnShowRfq").disabled;
      const unboundBanner = document.getElementById("qcDdGateBanner").textContent;

      // B. Blocked client -> hard-locked formal quote, internal math still works
      const lead = crmLeads.find(x => x.id === "ld_leg_1");
      lead.ddRecord = {
        decision: "blocked",
        reviewer: "ComplianceOfficer",
        evidence: "OFAC SDN match test",
        regChecked: true,
        sancChecked: true,
        score: 6,
        checkedAt: "2026-11-26 10:00",
        company: lead.company,
        country: lead.country,
        domain: "saigonvalve.vn",
        email: lead.email
      };
      saveLeadsLocal();
      await window._lastCrmSavePromise;
      window.refreshQuoteClientSelect();
      setVal("qcBindClient", "ld_leg_1");

      const blockedRfqDisabled = document.getElementById("btnShowRfq").disabled;
      const blockedCopyDisabled = document.getElementById("btnCopyQuote").disabled;
      const blockedSaveVerDisabled = document.getElementById("btnSaveQuoteVersion").disabled;
      const blockedMailtoHref = document.getElementById("btnRfqMailto").getAttribute("href");
      const internalMathStillWorks = !!(window._lastQuoteState && window._lastQuoteState.ok && window._lastQuoteState.fobUsd > 0);

      // C. Review client -> also hard-locked
      lead.ddRecord.decision = "review";
      window.refreshQuoteDdGate();
      const reviewRfqDisabled = document.getElementById("btnShowRfq").disabled;

      // D. Approved client -> unlocked & generates unique Ref
      lead.ddRecord.decision = "approved";
      lead.ddRecord.evidence = "Clean BIS/OFAC/UN + Vietnam Tax ID verified";
      window.refreshQuoteDdGate();
      const approvedRfqDisabled = document.getElementById("btnShowRfq").disabled;
      document.getElementById("btnShowRfq").click();
      const rfqVisible = !document.getElementById("rfqPreviewWrap").hidden;
      const refNo = window._lastQuoteState.refNo;

      return {
        unboundLocked,
        unboundWarnShown: unboundBanner.includes("Indicative Quotation"),
        blockedRfqDisabled,
        blockedCopyDisabled,
        blockedSaveVerDisabled,
        blockedMailtoCleared: !blockedMailtoHref,
        internalMathStillWorks,
        reviewRfqDisabled,
        approvedRfqDisabled,
        rfqVisible,
        refNoFormatOk: /^FG-\\d{8}-[A-Z0-9]+-[A-Z0-9]{4}-\\d{3}-V\\d+$/.test(refNo),
        refNo
      };
    })()`);
    assert.strictEqual(ddGateRes.unboundLocked, false);
    assert.strictEqual(ddGateRes.unboundWarnShown, true);
    assert.strictEqual(ddGateRes.blockedRfqDisabled, true);
    assert.strictEqual(ddGateRes.blockedCopyDisabled, true);
    assert.strictEqual(ddGateRes.blockedSaveVerDisabled, true);
    assert.strictEqual(ddGateRes.blockedMailtoCleared, true);
    assert.strictEqual(ddGateRes.internalMathStillWorks, true);
    assert.strictEqual(ddGateRes.reviewRfqDisabled, true);
    assert.strictEqual(ddGateRes.approvedRfqDisabled, false);
    assert.strictEqual(ddGateRes.rfqVisible, true);
    assert.strictEqual(ddGateRes.refNoFormatOk, true);
    report.results.quoteDdGate = { pass: true, ...ddGateRes };

    /* =========================================================================
     * 8. Order-Bound 6-Step Precheck (#precheck) + Reload Persistence
     * ========================================================================= */
    console.log("▶ [8/9] Verifying order-bound 6-step #precheck archive & client-switch reset...");
    const precheckStep1 = await tab1.evalJs(`(async () => {
      navigateTo("precheck");
      window.refreshPrecheckClientSelect();
      const bindSel = document.getElementById("pcBindClient");
      bindSel.value = "ld_leg_1";
      bindSel.dispatchEvent(new Event("change", { bubbles: true }));

      document.getElementById("pcOrderRef").value = "PI-20261126-E2E-01";
      document.getElementById("pcProductHs").value = "8481.80 Industrial Gate Valves";
      document.getElementById("pcEndUser").value = "Civil municipal water treatment plant";
      document.getElementById("pcEvidence").value = "CSL-20261126-CLEAN + EUS-01";
      document.getElementById("pcReviewer").value = "Jasun";
      document.querySelectorAll("#complianceChecklist input[type='checkbox']").forEach(cb => {
        cb.checked = true;
        cb.dispatchEvent(new Event("change", { bubbles: true }));
      });
      document.getElementById("pcDecision").value = "approved";
      document.getElementById("pcDecision").dispatchEvent(new Event("change", { bubbles: true }));
      document.getElementById("btnSavePrecheckOrder").click();
      await new Promise(r => setTimeout(r, 250));

      // Switch to Client B -> all 6 checkboxes, orderRef, and decision MUST reset!
      bindSel.value = "ld_leg_2";
      bindSel.dispatchEvent(new Event("change", { bubbles: true }));
      const checkedAfterSwitch = Array.from(document.querySelectorAll("#complianceChecklist input[type='checkbox']")).filter(cb => cb.checked).length;
      const orderRefAfterSwitch = document.getElementById("pcOrderRef").value;
      const decisionAfterSwitch = document.getElementById("pcDecision").value;
      return { checkedAfterSwitch, orderRefAfterSwitch, decisionAfterSwitch, logsInMem: complianceLogs.length };
    })()`);
    assert.strictEqual(precheckStep1.checkedAfterSwitch, 0, "Switching client must reset all 6 checkboxes");
    assert.strictEqual(precheckStep1.orderRefAfterSwitch, "", "Switching client must clear orderRef");
    assert.strictEqual(precheckStep1.decisionAfterSwitch, "pending", "Switching client must reset decision to pending");
    assert.strictEqual(precheckStep1.logsInMem, 1);

    await tab1.send("Page.reload");
    await new Promise((r) => setTimeout(r, 1000));
    const precheckAfterReload = await tab1.evalJs(`(async () => {
      await window._fgStoreReadyPromise;
      navigateTo("precheck");
      const historyHtml = document.getElementById("pcHistoryBox").innerHTML;
      return {
        persistedLogs: complianceLogs.length,
        showsArchiveBadge: historyHtml.includes("PI-20261126-E2E-01") && historyHtml.includes("审核放行") && historyHtml.includes("8481.80 Industrial Gate Valves")
      };
    })()`);
    assert.strictEqual(precheckAfterReload.persistedLogs, 1);
    assert.strictEqual(precheckAfterReload.showsArchiveBadge, true);
    report.results.orderBoundPrecheck = { pass: true, ...precheckStep1, ...precheckAfterReload };

    /* =========================================================================
     * 9. Performance Stress Benchmarks: 10,000 CRM Leads & 10,000 CSV Rows
     * ========================================================================= */
    console.log("▶ [9/9] Running 10,000 CRM leads & 10,000 CSV rows stress benchmarks...");
    const stressCrm = await tab1.evalJs(`(async () => {
      const countries = ["Vietnam", "Mexico", "Saudi Arabia", "Indonesia", "Brazil", "Poland", "Italy", "Thailand", "Chile", "United Arab Emirates"];
      const stages = ["重点跟进", "已发开发信", "有询盘", "已报价", "谈判逼单中"];
      const leads10k = [];
      const baseNow = Date.now();
      for (let i = 0; i < 10000; i++) {
        leads10k.push({
          id: "ld_stress_" + i,
          company: (i === 9999 ? "TargetNeedle9999 Heavy Valve Corp" : ("Global Industrial Buyer #" + i)),
          country: countries[i % countries.length],
          stage: stages[i % stages.length],
          nextDate: "2026-12-" + String((i % 28) + 1).padStart(2, "0"),
          email: "buyer" + i + "@corp" + i + ".example.com",
          phone: "+52 81 8000 " + String(1000 + (i % 8999)),
          product: "Industrial Valves & Steel",
          timeline: [{ tlId: "tl_s_" + i, ts: "2026-11-26 09:00", channel: "邮件", result: "首轮触达" }],
          quotes: [],
          updated: "2026-11-26",
          updatedAt: baseNow - i
        });
      }

      const tSync0 = performance.now();
      await window.FG_STORE.syncActiveLeads(leads10k, { replaceActive: true });
      const syncIdbMs = Math.round(performance.now() - tSync0);

      const tQuery0 = performance.now();
      const loadedSt = await window.FG_STORE.loadState();
      const dbQueryMs = Math.round(performance.now() - tQuery0);

      const tFirst0 = performance.now();
      await window.reloadCrmFromStore();
      navigateTo("client-list");
      const firstScreenRenderMs = Math.round(performance.now() - tFirst0);
      const domRowsInitial = document.querySelectorAll("#followBody tr.crm-row-tr").length;

      const tFilter0 = performance.now();
      const srch = document.getElementById("crmSearch");
      srch.value = "TargetNeedle9999";
      srch.dispatchEvent(new Event("input", { bubbles: true }));
      const needleRows = document.querySelectorAll("#followBody tr.crm-row-tr").length;
      srch.value = "";
      srch.dispatchEvent(new Event("input", { bubbles: true }));
      const filterRerenderMs = Math.round(performance.now() - tFilter0);
      const domRowsAfterClearFilter = document.querySelectorAll("#followBody tr.crm-row-tr").length;

      // Soft-delete all 10,000 active leads with pre-destructive snapshot -> verify ZERO truncation!
      const tClear0 = performance.now();
      const clearRes = await window.FG_STORE.clearAllActiveWithSnapshot({
        reason: "10k 压测清空保护快照",
        deletedBy: "StressRunner"
      });
      const stAfterClear = await window.FG_STORE.loadState();
      const clearWithSnapMs = Math.round(performance.now() - tClear0);

      // 1-click Snapshot Rollback of all 10,000 leads
      const tRb0 = performance.now();
      await window.FG_STORE.restoreSnapshot(clearRes.snapId);
      const stAfterRb = await window.FG_STORE.loadState();
      const rollback10kMs = Math.round(performance.now() - tRb0);

      return {
        syncIdbMs,
        dbQueryMs,
        firstScreenRenderMs,
        filterRerenderMs,
        domRowsInitial,
        domRowsAfterClearFilter,
        clearWithSnapMs,
        rollback10kMs,
        needleRows,
        loadedActiveCount: loadedSt.activeLeads.length,
        deletedRetainedNoCap: stAfterClear.deletedLeads.length,
        restoredActive10k: stAfterRb.activeLeads.length
      };
    })()`);
    assert.strictEqual(stressCrm.needleRows, 1, "Exact search match in 10,000 CRM rows");
    assert.strictEqual(stressCrm.domRowsInitial <= 200, true, "CRM paginated DOM rows must not exceed 200");
    assert.strictEqual(stressCrm.domRowsAfterClearFilter <= 200, true, "CRM paginated DOM rows after filter must not exceed 200");
    assert.ok(stressCrm.deletedRetainedNoCap >= 10000, "All 10,000+ soft-deleted leads retained without 50-item truncation");
    assert.strictEqual(stressCrm.restoredActive10k, 10000, "All 10,000 active leads restored from snapshot");
    assert.ok(stressCrm.firstScreenRenderMs < 2500, `10k CRM firstScreenRenderMs (${stressCrm.firstScreenRenderMs}ms) must be < 2500ms`);

    const stressCsv = await tab1.evalJs(`(async () => {
      navigateTo("csv-workbench");
      document.getElementById("btnClearCsv").click();
      const countries = ["Vietnam", "Mexico", "Italy", "Saudi Arabia", "Indonesia"];
      const lines = ["Company,Country,Email,Phone,Website"];
      for (let i = 0; i < 10000; i++) {
        const c = countries[i % countries.length];
        const ph = c === "Italy" ? ("02 " + String(10000000 + i)) : ("+52 81 " + String(10000000 + i) + " ext. " + (i % 500));
        lines.push("Multinational Industrial Branch #" + Math.floor(i / 2) + "," + c + ",buyer" + i + "@ind-" + i + ".com," + ph + ",https://ind-" + i + ".com");
      }
      const csvText = lines.join("\\n");
      const t0 = performance.now();
      document.getElementById("csvPasteInput").value = csvText;
      document.getElementById("btnParseCsv").click();
      const parseAndFirstRender10kMs = Math.round(performance.now() - t0);
      const csvDomRows = document.querySelectorAll("#csvTbody tr:not(.csv-more-row)").length;

      const tF0 = performance.now();
      const suspectBtn = document.querySelector('#csvFilterPills button[data-csvf="suspect"]');
      const allBtn = document.querySelector('#csvFilterPills button[data-csvf="all"]');
      if (suspectBtn && allBtn) {
        suspectBtn.click();
        allBtn.click();
      }
      const csvFilterRerenderMs = Math.round(performance.now() - tF0);
      return {
        parseAndFirstRender10kMs,
        csvFilterRerenderMs,
        csvDomRows,
        dedupedCount: window.getCsvLeadsCount()
      };
    })()`);
    assert.strictEqual(stressCsv.dedupedCount, 10000, "All 10,000 distinct CSV rows parsed and retained");
    assert.strictEqual(stressCsv.csvDomRows <= 500, true, "CSV paginated DOM rows must not exceed 500");
    assert.ok(stressCsv.parseAndFirstRender10kMs < 3000, `10k CSV parse+render (${stressCsv.parseAndFirstRender10kMs}ms) must be < 3000ms`);

    assert.strictEqual(tab1.pageErrors.length, 0, "Zero uncaught runtime/console errors throughout entire E2E & stress run");

    report.timingsMs = {
      crm10k_dbWriteMs: stressCrm.syncIdbMs,
      crm10k_dbQueryMs: stressCrm.dbQueryMs,
      crm10k_firstScreenRenderMs: stressCrm.firstScreenRenderMs,
      crm10k_filterRerenderMs: stressCrm.filterRerenderMs,
      crm10k_clearWithSnapshotMs: stressCrm.clearWithSnapMs,
      crm10k_snapshotRollbackMs: stressCrm.rollback10kMs,
      csv10k_parseAndFirstRenderMs: stressCsv.parseAndFirstRender10kMs,
      csv10k_filterRerenderMs: stressCsv.csvFilterRerenderMs
    };
    report.results.stress10kCrm = { pass: true, ...stressCrm };
    report.results.stress10kCsv = { pass: true, ...stressCsv };
    report.pageErrors = tab1.pageErrors;

    fs.mkdirSync(path.join(ROOT, "tests/artifacts"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, "tests/artifacts/e2e-stress-report.json"), JSON.stringify(report, null, 2));
    console.log("\n✅ ALL E2E, FAILURE-INJECTION & 10K/10K STRESS VERIFICATIONS PASSED!");
    console.log(JSON.stringify(report.timingsMs, null, 2));

    tab1.ws.close();
  } finally {
    chrome.kill();
    srv.close();
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch (_) {}
  }
})();
