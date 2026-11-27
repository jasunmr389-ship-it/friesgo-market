#!/usr/bin/env node
/**
 * FriesGo Global V2.1 M2-A Browser End-to-End Verification Suite
 * Zero external npm deps: runs real Headless Chrome (1440px & 390px) against:
 *   - Real index.html + js/fg-core.js + js/fg-store.js + js/fg-cloud.js + js/fg-cloud-ui.js
 *   - Real Cloudflare Worker router (workers/friesgo-api/src/index.js) backed by real SQLite (0001_init.sql)
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import worker from "../workers/friesgo-api/src/index.js";
import { generateTotpCode } from "../workers/friesgo-api/src/totp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SCHEMA_SQL = fs.readFileSync(path.join(ROOT, "workers", "friesgo-api", "migrations", "0001_init.sql"), "utf8");
const CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function createSqliteD1() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(SCHEMA_SQL);
  function wrapStmt(sql, params = []) {
    return {
      bind(...args) {
        return wrapStmt(sql, args);
      },
      async first() {
        const row = raw.prepare(sql).get(...params);
        return row === undefined ? null : { ...row };
      },
      async all() {
        const rows = raw.prepare(sql).all(...params);
        return { results: rows.map((r) => ({ ...r })), success: true };
      },
      async run() {
        const info = raw.prepare(sql).run(...params);
        return { success: true, meta: { changes: Number(info.changes || 0) } };
      },
    };
  }
  return { raw, prepare: (sql) => wrapStmt(sql, []) };
}

function startStaticServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const clean = (req.url || "/").split("?")[0];
      const rel = clean === "/" ? "index.html" : clean.replace(/^\/+/, "");
      const fp = path.join(ROOT, rel);
      if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
      fs.createReadStream(fp).pipe(res);
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}

function startWorkerServer(env) {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const ch of req) chunks.push(ch);
      const rawBody = Buffer.concat(chunks);
      const url = `http://127.0.0.1:${srv.address().port}${req.url}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) headers.set(k, v.join(", "));
        else if (v != null) headers.set(k, String(v));
      }
      const wReq = new Request(url, {
        method: req.method,
        headers,
        body: ["GET", "HEAD", "OPTIONS"].includes(req.method) ? undefined : rawBody,
      });
      const wRes = await worker.fetch(wReq, env);
      const outHdrs = {};
      wRes.headers.forEach((v, k) => {
        outHdrs[k] = v;
      });
      res.writeHead(wRes.status, outHdrs);
      const buf = Buffer.from(await wRes.arrayBuffer());
      res.end(buf);
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}

async function launchChrome() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-m2a-chrome-"));
  const chrome = spawn(
    CHROME_BIN,
    ["--headless=new", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${userDataDir}`, "about:blank"],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = "";
    chrome.stderr.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) resolve(m[1]);
    });
    setTimeout(() => reject(new Error("Chrome startup timeout")), 12000);
  });
  const infoPort = wsUrl.match(/:(\d+)\//)[1];
  const targets = await (await fetch(`http://127.0.0.1:${infoPort}/json`)).json();
  const pageWs = targets.find((t) => t.type === "page").webSocketDebuggerUrl;
  const ws = new WebSocket(pageWs);
  await new Promise((r) => ws.addEventListener("open", r));
  let seq = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    }
    if (msg.method === "Runtime.exceptionThrown") {
      pageErrors.push(msg.params.exceptionDetails.text + " " + (msg.params.exceptionDetails.exception?.description || ""));
    }
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, { resolve: res, reject: rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || ""));
    }
    return r.result.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  return { chrome, ws, send, evalJs, pageErrors, userDataDir };
}

(async () => {
  const db = createSqliteD1();
  const BOOT = "m2a_e2e_bootstrap_secret_9876543210";
  const env = {
    DB: db,
    ENVIRONMENT: "staging",
    ALLOWED_ORIGINS: "http://127.0.0.1,http://localhost",
    AUTH_PEPPER: "e2e_pepper_32_chars_minimum_9876543210",
    TOTP_ENC_KEY: Buffer.alloc(32, 9).toString("base64"),
    BOOTSTRAP_SECRET: BOOT,
    LOCK_TTL_SECONDS: "600",
    SESSION_TTL_DAYS: "30",
    GMAPS_TEAM_MONTHLY_CAP: "950",
    GMAPS_EMP_MONTHLY_CAP: "250",
  };
  const { srv: staticSrv, port: staticPort } = await startStaticServer();
  const { srv: apiSrv, port: apiPort } = await startWorkerServer(env);
  const apiUrl = `http://127.0.0.1:${apiPort}`;

  // Bootstrap super_admin directly via API (as in real deployment)
  const bootRes = await fetch(`${apiUrl}/api/auth/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bootstrap-Secret": BOOT },
    body: JSON.stringify({ login_id: "boss", display_name: "老板管理员", password: "BossPassword123" }),
  });
  assert.equal(bootRes.status, 201);

  const cdp = await launchChrome();
  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${staticPort}/index.html` });
    await new Promise((r) => setTimeout(r, 1200));

    // Point FG_CLOUD at our real local SQLite Worker API
    await cdp.evalJs(`window.FG_CLOUD.setApiBase(${JSON.stringify(apiUrl)});`);

    // ===== PASS 1: External Visitor / Guest Isolation =====
    const guest = await cdp.evalJs(`(() => ({
      authBtn: document.getElementById("btnCloudAuth").textContent,
      poolBarHidden: document.getElementById("cloudPoolBar").hidden,
      localCrmVisible: !document.getElementById("localCrmCardWrap").hidden,
      fbCloudHidden: document.getElementById("fbCloudSection").hidden
    }))()`);
    assert.ok(guest.authBtn.includes("员工登录"));
    assert.equal(guest.poolBarHidden, true);
    assert.equal(guest.localCrmVisible, true);
    assert.equal(guest.fbCloudHidden, true);
    console.log("PASS 1: Guest/external visitor mode isolated (cloud pool & cloud feedback hidden, local tools intact)");

    // ===== PASS 2: Super-Admin Login & Mandatory 2FA Setup via Real Modal UI =====
    const totpSecret = await cdp.evalJs(`(async () => {
      document.getElementById("btnCloudAuth").click();
      document.getElementById("inpCloudLoginId").value = "boss";
      document.getElementById("inpCloudPwd").value = "BossPassword123";
      document.getElementById("btnCloudDoLogin").click();
      await new Promise(r => setTimeout(r, 350));
      // Must now show mandatory 2FA setup button
      document.getElementById("btnStartTotpSetup").click();
      await new Promise(r => setTimeout(r, 350));
      const sec = document.querySelector("#totpSetupOutput code").textContent.trim();
      return sec;
    })()`);
    assert.ok(totpSecret.length >= 16, "Super-admin 2FA secret must be generated");

    const liveCode = await generateTotpCode(totpSecret);
    const after2fa = await cdp.evalJs(`(async () => {
      document.getElementById("inpTotpConfirmCode").value = ${JSON.stringify(liveCode)};
      document.getElementById("btnConfirmTotp").click();
      await new Promise(r => setTimeout(r, 350));
      return {
        modalHidden: document.getElementById("cloudAuthModal").hidden,
        authBtn: document.getElementById("btnCloudAuth").textContent,
        poolBarVisible: !document.getElementById("cloudPoolBar").hidden
      };
    })()`);
    assert.equal(after2fa.modalHidden, true);
    assert.ok(after2fa.authBtn.includes("老板管理员"));
    assert.equal(after2fa.poolBarVisible, true);
    console.log("PASS 2: Super-admin login & mandatory 2FA enrollment modal verified");

    // ===== PASS 3: Super-Admin Creates 2 Employees via Admin Modal with 2FA =====
    const codeAdm = await generateTotpCode(totpSecret);
    const admRes = await cdp.evalJs(`(async () => {
      window.FG_CLOUD_UI.openAdminModal();
      await new Promise(r => setTimeout(r, 350));
      document.getElementById("inpAdminTotp").value = ${JSON.stringify(codeAdm)};
      document.getElementById("admNewLogin").value = "alice";
      document.getElementById("admNewName").value = "业务员A";
      document.getElementById("admNewPwd").value = "AlicePass123";
      document.getElementById("btnAdmCreateEmp").click();
      await new Promise(r => setTimeout(r, 350));
      document.getElementById("admNewLogin").value = "bob";
      document.getElementById("admNewName").value = "业务员B";
      document.getElementById("admNewPwd").value = "BobPass1234";
      document.getElementById("btnAdmCreateEmp").click();
      await new Promise(r => setTimeout(r, 350));
      const txt = document.getElementById("cloudAdminTabBody").textContent;
      document.getElementById("cloudAdminModal").hidden = true;
      await window.FG_CLOUD.logout();
      return { txt, loggedOut: !window.FG_CLOUD.getState().loggedIn };
    })()`);
    assert.ok(admRes.txt.includes("业务员A") && admRes.txt.includes("业务员B"));
    assert.equal(admRes.loggedOut, true);
    console.log("PASS 3: Super-admin created Staff A & Staff B with 2FA verification and logged out cleanly");

    // ===== PASS 4: Staff A Creates Company in Pool -> Staff B Sees It + Atomic Lock & Coordination =====
    const shareRes = await cdp.evalJs(`(async () => {
      await window.FG_CLOUD.login("alice", "AlicePass123");
      navigateTo("client-list");
      await new Promise(r => setTimeout(r, 300));
      document.getElementById("btnCloudNewCompany").click();
      document.getElementById("cloudNewCompName").value = "Dammam Gulf Valve Corp";
      document.getElementById("cloudNewCompCountry").value = "Saudi Arabia";
      document.getElementById("cloudNewCompCity").value = "Dammam";
      document.getElementById("cloudNewCompWeb").value = "https://gulfvalve.sa";
      document.getElementById("cloudNewCompProd").value = "工业阀门";
      document.getElementById("btnCloudSaveNewComp").click();
      await new Promise(r => setTimeout(r, 400));

      // Alice acquires lock & records sent email
      document.querySelector("[data-cloud-lock]").click();
      await new Promise(r => setTimeout(r, 350));
      document.getElementById("inpEvSummary").value = "已发送阀门英文目录";
      document.getElementById("btnLockSaveEvent").click();
      await new Promise(r => setTimeout(r, 400));

      // Switch to Bob -> Bob sees Dammam Gulf Valve Corp & gets colleague history warning on lock!
      await window.FG_CLOUD.logout();
      await window.FG_CLOUD.login("bob", "BobPass1234");
      window.FG_CLOUD_UI.loadCloudActiveTab();
      await new Promise(r => setTimeout(r, 400));
      const poolTxt = document.getElementById("cloudPoolListBody").textContent;
      document.querySelector("[data-cloud-lock]").click();
      await new Promise(r => setTimeout(r, 400));
      const hasColWarn = !!document.getElementById("chkColleagueCoordinated");
      document.getElementById("chkColleagueCoordinated").checked = true;
      document.getElementById("inpEvOutcome").value = "unsubscribed";
      document.getElementById("inpEvSummary").value = "客户退订";
      document.getElementById("btnLockSaveEvent").click();
      await new Promise(r => setTimeout(r, 450));
      const afterOptOutTxt = document.getElementById("cloudPoolListBody").textContent;
      const lockBtnsLeft = document.querySelectorAll("[data-cloud-lock]").length;
      return { poolTxt, hasColWarn, afterOptOutTxt, lockBtnsLeft };
    })()`);
    assert.ok(shareRes.poolTxt.includes("Dammam Gulf Valve Corp") && shareRes.poolTxt.includes("业务员A"));
    assert.equal(shareRes.hasColWarn, true, "Colleague history coordination checkbox must appear for Bob");
    assert.ok(shareRes.afterOptOutTxt.includes("已禁发/退订"));
    assert.equal(shareRes.lockBtnsLeft, 0, "Opted-out company must hard-block active contact lock button");
    console.log("PASS 4: Cross-employee pool sharing, atomic lock, colleague coordination & opt-out hard-block verified");

    // ===== PASS 5: Offline Lock Refusal + Offline Event Queueing & Online Flush =====
    const offlineCheck = await cdp.evalJs(`(async () => {
      const created = await window.FG_CLOUD.createCompany({ canonical_name: "Offline Queue Test Plant", country_en: "Mexico", city: "Monterrey", source_type: "manual" });
      const cid = created.data.company.id;
      const realFetch = window.fetch;
      window.fetch = () => Promise.reject(new TypeError("Failed to fetch"));
      const lockRes = await window.FG_CLOUD.acquireLock(cid, "phone");
      const evRes = await window.FG_CLOUD.recordEvent({ company_id: cid, channel: "phone", action_outcome: "no_answer", summary: "离线拨打未接通" });
      const pendingBefore = window.FG_CLOUD.getState().pendingCount;
      window.fetch = realFetch;
      const flushed = await window.FG_CLOUD.flushPendingQueue();
      const pendingAfter = window.FG_CLOUD.getState().pendingCount;
      return { lockOk: lockRes.ok, lockOffline: lockRes.offline, queued: evRes.queuedOffline, pendingBefore, flushed, pendingAfter };
    })()`);
    assert.equal(offlineCheck.lockOk, false);
    assert.equal(offlineCheck.lockOffline, true, "Offline lock MUST NEVER fake success");
    assert.equal(offlineCheck.queued, true);
    assert.equal(offlineCheck.pendingBefore, 1);
    assert.equal(offlineCheck.flushed.flushed, 1);
    assert.equal(offlineCheck.pendingAfter, 0);
    console.log("PASS 5: Offline lock hard-refusal + offline event queueing & online idempotent flush verified");

    // ===== PASS 6: 6-Step Safe IndexedDB Migration Wizard (Local DB Preserved) =====
    const migCheck = await cdp.evalJs(`(async () => {
      // Seed 1 local IndexedDB lead via addCustomerToCrm
      window.addCustomerToCrm({ company: "Legacy Local Steel Co.", country: "Vietnam", email: "buy@legacysteel.vn", product: "钢结构" });
      await new Promise(r => setTimeout(r, 300));
      window.FG_CLOUD_UI.openMigrateModal();
      await new Promise(r => setTimeout(r, 350));
      document.getElementById("btnMigStep1Backup").click();
      document.getElementById("btnMigStep2DryRun").click();
      await new Promise(r => setTimeout(r, 400));
      const dryTxt = document.getElementById("migPreviewArea").textContent;
      document.getElementById("btnMigStep4Commit").click();
      await new Promise(r => setTimeout(r, 500));
      const commitTxt = document.getElementById("migCommitReport").textContent;
      document.getElementById("cloudMigrateModal").hidden = true;
      const localAfter = await window.FG_STORE.loadState();
      return { dryTxt, commitTxt, localCountPreserved: (localAfter.activeLeads || []).length };
    })()`);
    assert.ok(migCheck.dryTxt.includes("将新建 1 家"));
    assert.ok(migCheck.commitTxt.includes("新建主档 1 家"));
    assert.ok(migCheck.localCountPreserved >= 1, "Migration MUST NOT wipe local IndexedDB");
    console.log("PASS 6: 6-step lossless IndexedDB -> Cloud migration wizard verified (local DB preserved)");

    // ===== PASS 7: Cloud Co-Creation Feedback Board (PII Redacted) =====
    const fbCloud = await cdp.evalJs(`(async () => {
      document.getElementById("btnOpenFeedback").click();
      await new Promise(r => setTimeout(r, 300));
      document.getElementById("fbMessage").value = "建议增加客户名 email@secret.vn +84 903 888 999 快速检索";
      document.getElementById("btnFbSubmitCloud").click();
      await new Promise(r => setTimeout(r, 450));
      const boardTxt = document.getElementById("fbCloudBoardList").textContent;
      document.getElementById("btnCloseFeedback").click();
      return { boardTxt };
    })()`);
    assert.ok(fbCloud.boardTxt.includes("业务员B") && !fbCloud.boardTxt.includes("email@secret.vn") && !fbCloud.boardTxt.includes("888 999"));
    console.log("PASS 7: Authenticated cloud co-creation feedback board & server PII scrubbing verified");

    // ===== PASS 8: Mobile 390x844 Layout & Zero Horizontal Overflow =====
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await new Promise((r) => setTimeout(r, 300));
    const mob = await cdp.evalJs(`(async () => {
      navigateTo("client-list");
      window.FG_CLOUD_UI.loadCloudActiveTab();
      await new Promise(r => setTimeout(r, 350));
      const ovPool = Math.max(0, document.documentElement.scrollWidth - window.innerWidth);
      window.FG_CLOUD_UI.openAuthModal();
      await new Promise(r => setTimeout(r, 200));
      const ovAuth = Math.max(0, document.documentElement.scrollWidth - window.innerWidth);
      document.getElementById("cloudAuthModal").hidden = true;
      return { ovPool, ovAuth };
    })()`);
    assert.equal(mob.ovPool, 0, `Expected 0px overflow on 390px cloud pool, got ${mob.ovPool}`);
    assert.equal(mob.ovAuth, 0, `Expected 0px overflow on 390px auth modal, got ${mob.ovAuth}`);
    assert.equal(cdp.pageErrors.length, 0, `Uncaught page errors: ${cdp.pageErrors.join(" | ")}`);
    console.log("PASS 8: Mobile 390x844 cloud pool & modals verified with 0px overflow & 0 page errors");
    console.log("ALL V2.1 M2-A BROWSER E2E CHECKS PASSED!");
  } finally {
    try { cdp.ws.close(); } catch (_) {}
    cdp.chrome.kill("SIGKILL");
    staticSrv.close();
    apiSrv.close();
    await new Promise((r) => setTimeout(r, 250));
    try { fs.rmSync(cdp.userDataDir, { recursive: true, force: true }); } catch (_) {}
  }
})().catch((err) => {
  console.error("V2.1 M2-A E2E FAILED:", err);
  process.exit(1);
});
