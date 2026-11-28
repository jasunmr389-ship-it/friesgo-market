/* FriesGo Global V2.1 M2-A: Cloud Company Pool, Employee Auth/2FA, Atomic Locks & Sync Client
 * Zero external dependencies. Works in desktop browsers, mobile Safari/Chrome & WeChat WebView (Bearer header, no 3rd-party cookies).
 */
(function (global) {
  "use strict";

  var DEFAULT_API_BASE = "https://friesgo-api.ntigravity-project.workers.dev";
  var SESSION_KEY = "friesgo_cloud_session_v1";
  var PENDING_KEY = "friesgo_cloud_pending_v1";
  var FAILED_KEY = "friesgo_cloud_failed_v1";
  var API_URL_KEY = "friesgo_cloud_api_url_v1";
  var MAX_PENDING_QUEUE = 200;
  var IDB_QUEUE_DB = "friesgo_cloud_queue_v1";
  var IDB_QUEUE_STORE = "cloud_event_queue";

  var listeners = [];
  var activeLocks = Object.create(null); // { [companyId]: { lock_id, expires_at, channel } }
  var flushInFlight = null;
  var flushRequestedAgain = false;
  var idbQueuePromise = null;
  var state = {
    session: null, // { token, sessionId, expiresAt, employee, requireTotpSetup }
    syncStatus: "guest", // guest | synced | syncing | offline | error
    lastSyncedAt: "",
    lastError: "",
    pendingCount: 0,
    failedCount: 0,
    restoreFrozen: false,
  };

  function openQueueIdb() {
    if (typeof indexedDB === "undefined") return Promise.resolve(null);
    if (idbQueuePromise) return idbQueuePromise;
    idbQueuePromise = new Promise(function (resolve) {
      try {
        var req = indexedDB.open(IDB_QUEUE_DB, 1);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(IDB_QUEUE_STORE)) {
            db.createObjectStore(IDB_QUEUE_STORE, { keyPath: "event_id" });
          }
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { idbQueuePromise = null; resolve(null); };
      } catch (_) {
        idbQueuePromise = null;
        resolve(null);
      }
    });
    return idbQueuePromise;
  }

  function idbQueuePutRecord(rec) {
    if (!rec || !rec.event_id) return Promise.resolve(false);
    return openQueueIdb().then(function (db) {
      if (!db) return false;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(IDB_QUEUE_STORE, "readwrite");
          tx.objectStore(IDB_QUEUE_STORE).put(rec);
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { resolve(false); };
          tx.onabort = function () { resolve(false); };
        } catch (_) {
          resolve(false);
        }
      });
    });
  }

  function idbQueueDeleteIds(ids) {
    if (!Array.isArray(ids) || !ids.length) return Promise.resolve(false);
    return openQueueIdb().then(function (db) {
      if (!db) return false;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(IDB_QUEUE_STORE, "readwrite");
          var st = tx.objectStore(IDB_QUEUE_STORE);
          ids.forEach(function (id) { if (id) st.delete(id); });
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { resolve(false); };
          tx.onabort = function () { resolve(false); };
        } catch (_) {
          resolve(false);
        }
      });
    });
  }

  function idbQueueClearAll() {
    return openQueueIdb().then(function (db) {
      if (!db) return false;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(IDB_QUEUE_STORE, "readwrite");
          tx.objectStore(IDB_QUEUE_STORE).clear();
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { resolve(false); };
        } catch (_) {
          resolve(false);
        }
      });
    });
  }

  function idbQueueLoadAll() {
    return openQueueIdb().then(function (db) {
      if (!db) return [];
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(IDB_QUEUE_STORE, "readonly");
          var req = tx.objectStore(IDB_QUEUE_STORE).getAll();
          req.onsuccess = function () { resolve(Array.isArray(req.result) ? req.result : []); };
          req.onerror = function () { resolve([]); };
        } catch (_) {
          resolve([]);
        }
      });
    });
  }

  function getApiBase() {
    if (global.FG_CLOUD_API_OVERRIDE) {
      return String(global.FG_CLOUD_API_OVERRIDE).replace(/\/+$/, "");
    }
    try {
      var custom = localStorage.getItem(API_URL_KEY);
      if (custom && /^https?:\/\//i.test(custom.trim())) {
        return custom.trim().replace(/\/+$/, "");
      }
    } catch (_) {}
    return DEFAULT_API_BASE;
  }

  function setApiBase(url) {
    var clean = String(url || "").trim().replace(/\/+$/, "");
    try {
      if (clean) localStorage.setItem(API_URL_KEY, clean);
      else localStorage.removeItem(API_URL_KEY);
    } catch (_) {}
  }

  function loadSession() {
    try {
      var raw = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
      if (raw && raw.token && raw.employee) {
        if (raw.expiresAt && raw.expiresAt <= new Date().toISOString()) {
          localStorage.removeItem(SESSION_KEY);
          return null;
        }
        return raw;
      }
    } catch (_) {}
    return null;
  }

  function saveSession(sess) {
    state.session = sess || null;
    try {
      if (sess) localStorage.setItem(SESSION_KEY, JSON.stringify(sess));
      else localStorage.removeItem(SESSION_KEY);
    } catch (_) {}
  }

  function loadPendingQueue() {
    try {
      var arr = JSON.parse(localStorage.getItem(PENDING_KEY) || "[]");
      return Array.isArray(arr) ? arr : [];
    } catch (_) {
      return [];
    }
  }

  function savePendingQueue(arr) {
    var list = Array.isArray(arr) ? arr : [];
    if (list.length > MAX_PENDING_QUEUE) {
      return { ok: false, queueFull: true, error: "待同步离线队列已达上限（" + MAX_PENDING_QUEUE + " 条），请先恢复联网同步" };
    }
    try {
      if (list.length) localStorage.setItem(PENDING_KEY, JSON.stringify(list));
      else localStorage.removeItem(PENDING_KEY);
      state.pendingCount = list.length;
      return { ok: true, count: list.length };
    } catch (err) {
      // R03: NEVER fabricate memory count on storage failure; reflect actual persisted truth
      state.pendingCount = loadPendingQueue().length;
      return {
        ok: false,
        storageFull: true,
        error: "浏览器本地存储写入失败（空间不足或被禁用）：" + ((err && err.message) || "QuotaExceeded"),
      };
    }
  }

  function loadFailedQueue() {
    try {
      var arr = JSON.parse(localStorage.getItem(FAILED_KEY) || "[]");
      return Array.isArray(arr) ? arr : [];
    } catch (_) {
      return [];
    }
  }

  // R02 / R03: NEVER silently slice/truncate failed records; NEVER fabricate memory count when persistence throws!
  function saveFailedQueue(arr) {
    var list = Array.isArray(arr) ? arr.slice() : [];
    try {
      if (list.length) localStorage.setItem(FAILED_KEY, JSON.stringify(list));
      else localStorage.removeItem(FAILED_KEY);
      state.failedCount = list.length;
      return { ok: true, count: list.length };
    } catch (err) {
      state.failedCount = loadFailedQueue().length;
      return {
        ok: false,
        storageFull: true,
        error: "失败队列持久化存储写入失败（原待同步记录已完整保留未删除）：" + ((err && err.message) || "QuotaExceeded"),
      };
    }
  }

  function computeHealthySyncStatus() {
    if (!state.session) return "guest";
    if (state.restoreFrozen) return "error";
    if (state.failedCount > 0) return "error";
    if (state.pendingCount > 0) return "offline";
    return "synced";
  }

  /**
   * Immediately wipe all controllable private caches, tokens, pending/failed queues & active locks
   * on logout OR server 401 SESSION_REVOKED_OR_DISABLED.
   */
  function clearAllPrivateState(reason) {
    saveSession(null);
    savePendingQueue([]);
    saveFailedQueue([]);
    idbQueueClearAll();
    activeLocks = Object.create(null);
    flushRequestedAgain = false;
    state.syncStatus = "guest";
    state.lastSyncedAt = "";
    state.lastError = reason || "";
    state.restoreFrozen = false;
    emitChange("cleared");
  }

  function emitChange(eventType) {
    var snap = getState();
    listeners.forEach(function (fn) {
      try {
        fn(snap, eventType || "update");
      } catch (_) {}
    });
  }

  function subscribe(fn) {
    if (typeof fn === "function") listeners.push(fn);
    return function () {
      listeners = listeners.filter(function (x) {
        return x !== fn;
      });
    };
  }

  function getState() {
    return {
      apiBase: getApiBase(),
      loggedIn: Boolean(state.session && state.session.token && state.session.employee),
      requireTotpSetup: Boolean(state.session && state.session.requireTotpSetup),
      employee: state.session ? state.session.employee : null,
      sessionId: state.session ? state.session.sessionId : "",
      syncStatus: state.syncStatus,
      lastSyncedAt: state.lastSyncedAt,
      lastError: state.lastError,
      pendingCount: state.pendingCount,
      failedCount: state.failedCount,
      restoreFrozen: state.restoreFrozen,
      maxPendingQueue: MAX_PENDING_QUEUE,
      activeLocks: Object.assign({}, activeLocks),
    };
  }

  function genStableEventId() {
    return "ev_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
  }

  function detectDeviceLabel() {
    var ua = String((navigator && navigator.userAgent) || "");
    var isWx = /MicroMessenger/i.test(ua);
    var os = /iPhone/i.test(ua)
      ? "iPhone"
      : /iPad/i.test(ua)
        ? "iPad"
        : /Android/i.test(ua)
          ? "Android"
          : /Mac OS X/i.test(ua)
            ? "macOS"
            : /Windows/i.test(ua)
              ? "Windows"
              : "Browser";
    return (isWx ? "微信 · " : "") + os;
  }

  function apiFetch(path, opts) {
    var o = opts || {};
    var method = o.method || "GET";
    var headers = Object.assign({}, o.headers || {});
    if (o.auth !== false && state.session && state.session.token) {
      headers.Authorization = "Bearer " + state.session.token;
    }
    if (o.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (state.session && o.trackSync !== false) {
      state.syncStatus = "syncing";
      emitChange("syncing");
    }

    var url = getApiBase() + path;
    var fetchOpts = {
      method: method,
      headers: headers,
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    };

    return fetch(url, fetchOpts)
      .then(function (res) {
        return res.text().then(function (txt) {
          var data = {};
          try {
            data = txt ? JSON.parse(txt) : {};
          } catch (_) {
            data = { error: "服务端返回非 JSON 响应 (HTTP " + res.status + ")" };
          }
          if (res.status === 401 && data && data.code === "SESSION_REVOKED_OR_DISABLED" && state.session) {
            clearAllPrivateState(data.error || "会话已失效或账号已停用");
            return { ok: false, status: 401, revoked: true, data: data };
          }
          if (res.status === 503 && data && data.code === "SYSTEM_RESTORE_FROZEN") {
            state.restoreFrozen = true;
            state.lastError = data.error || "系统处于恢复后安全冻结期";
            if (state.session) {
              state.syncStatus = "error";
              emitChange("restore_frozen");
            }
            return { ok: false, status: 503, restoreFrozen: true, data: data };
          }
          if (res.ok) {
            if (state.session && o.trackSync !== false) {
              state.lastSyncedAt = new Date().toISOString();
              if (!state.failedCount && !state.pendingCount && !state.restoreFrozen) state.lastError = "";
              state.syncStatus = computeHealthySyncStatus();
              emitChange("synced");
            }
            return { ok: true, status: res.status, data: data };
          }
          if (state.session && o.trackSync !== false && (res.status >= 500 || res.status === 429 || res.status === 408)) {
            state.lastError = data.error || ("HTTP " + res.status);
            state.syncStatus = "error";
            emitChange("error");
          } else if (state.session && o.trackSync !== false) {
            state.syncStatus = computeHealthySyncStatus();
            emitChange("update");
          }
          return { ok: false, status: res.status, data: data };
        });
      })
      .catch(function (err) {
        var msg = (err && err.message) || "网络连接失败";
        if (state.session) {
          state.lastError = msg;
          state.syncStatus = (typeof navigator !== "undefined" && navigator.onLine === false) ? "offline" : "error";
          emitChange("offline");
        }
        return { ok: false, status: 0, networkError: true, data: { error: "无法连接云端服务：" + msg } };
      });
  }

  function getHealth() {
    return apiFetch("/api/health", { method: "GET", auth: false, trackSync: false });
  }

  // ===== Auth & 2FA =====
  function login(loginId, password, totpCode) {
    var prevEmpId = state.session && state.session.employee ? state.session.employee.id : "";
    return apiFetch("/api/auth/login", {
      method: "POST",
      auth: false,
      trackSync: false,
      body: {
        login_id: String(loginId || "").trim().toLowerCase(),
        password: String(password || ""),
        totp_code: totpCode ? String(totpCode).trim() : "",
        device_label: detectDeviceLabel(),
      },
    }).then(function (r) {
      if (r.ok && r.data && r.data.token && r.data.employee) {
        var nextEmpId = r.data.employee.id || "";
        var switchedAccount = Boolean(prevEmpId && nextEmpId && prevEmpId !== nextEmpId);
        if (switchedAccount) {
          savePendingQueue([]);
          saveFailedQueue([]);
          idbQueueClearAll();
          activeLocks = Object.create(null);
        }
        saveSession({
          token: r.data.token,
          sessionId: r.data.sessionId,
          expiresAt: r.data.expiresAt,
          employee: r.data.employee,
          requireTotpSetup: Boolean(r.data.requireTotpSetup),
        });
        state.restoreFrozen = Boolean(r.data.restoreFrozen);
        state.syncStatus = computeHealthySyncStatus();
        state.lastSyncedAt = new Date().toISOString();
        state.lastError = "";
        emitChange(switchedAccount ? "account_switched" : "login");
      }
      return r;
    });
  }

  function totpSetup() {
    return apiFetch("/api/auth/totp/setup", { method: "POST", body: {} });
  }

  function totpConfirm(totpCode) {
    return apiFetch("/api/auth/totp/confirm", {
      method: "POST",
      body: { totp_code: String(totpCode || "").trim() },
    }).then(function (r) {
      if (r.ok && state.session) {
        state.session.requireTotpSetup = false;
        if (state.session.employee) state.session.employee.totp_enabled = true;
        saveSession(state.session);
        emitChange("totp_confirmed");
      }
      return r;
    });
  }

  function refreshMe() {
    if (!state.session) return Promise.resolve({ ok: false, status: 401, data: { error: "未登录" } });
    return apiFetch("/api/auth/me", { method: "GET" }).then(function (r) {
      if (r.ok && r.data && r.data.employee && state.session) {
        state.session.employee = r.data.employee;
        state.session.requireTotpSetup = Boolean(r.data.requireTotpSetup);
        state.restoreFrozen = Boolean(r.data.restoreFrozen);
        state.syncStatus = computeHealthySyncStatus();
        saveSession(state.session);
        emitChange("me");
      }
      return r;
    });
  }

  function logout() {
    var p = state.session
      ? apiFetch("/api/auth/logout", { method: "POST", body: {}, trackSync: false })
      : Promise.resolve({ ok: true });
    return p.finally(function () {
      clearAllPrivateState("");
    });
  }

  function changePassword(oldPassword, newPassword) {
    return apiFetch("/api/auth/change-password", {
      method: "POST",
      body: { old_password: oldPassword, new_password: newPassword },
    }).then(function (r) {
      if (r.ok && state.session && state.session.employee) {
        state.session.employee.must_reset_pwd = false;
        saveSession(state.session);
        emitChange("password_changed");
      }
      return r;
    });
  }

  function listOwnSessions() {
    return apiFetch("/api/auth/sessions", { method: "GET" });
  }

  function revokeOwnSession(sessionId) {
    return apiFetch("/api/auth/sessions/" + encodeURIComponent(sessionId), { method: "DELETE" });
  }

  // ===== Admin Governance =====
  function listEmployees() {
    return apiFetch("/api/admin/employees", { method: "GET" });
  }
  function createEmployee(payload) {
    return apiFetch("/api/admin/employees", { method: "POST", body: payload });
  }
  function createEmployeesBatch(employees, totpCode) {
    return apiFetch("/api/admin/employees/batch", {
      method: "POST",
      body: { employees: employees || [], totp_code: totpCode || "" },
    });
  }
  function updateEmployee(id, payload) {
    return apiFetch("/api/admin/employees/" + encodeURIComponent(id), { method: "PATCH", body: payload });
  }
  function listEmployeeSessions(id) {
    return apiFetch("/api/admin/employees/" + encodeURIComponent(id) + "/sessions", { method: "GET" });
  }
  function revokeEmployeeSessions(id, payload) {
    return apiFetch("/api/admin/employees/" + encodeURIComponent(id) + "/revoke-sessions", { method: "POST", body: payload });
  }
  function listAuditLogs(limit) {
    return apiFetch("/api/admin/audit-logs?limit=" + (limit || 50), { method: "GET" });
  }
  function listRestoreJobs() {
    return apiFetch("/api/admin/restore-jobs", { method: "GET" });
  }
  function exportBackup(totpCode) {
    return apiFetch("/api/admin/export-backup", { method: "POST", body: { totp_code: totpCode } });
  }
  function restoreBackup(totpCode, confirmPhrase, tables, opts) {
    var payload = { totp_code: totpCode, confirmPhrase: confirmPhrase || "", tables: tables || {} };
    if (opts && opts.counts) payload.counts = opts.counts;
    if (opts && opts.snapshotSha256) payload.snapshotSha256 = opts.snapshotSha256;
    return apiFetch("/api/admin/restore-backup", {
      method: "POST",
      body: payload,
    }).then(function (r) {
      if (r.ok || (r.data && r.data.restoreFrozen)) {
        state.restoreFrozen = true;
        state.syncStatus = "error";
        emitChange("restore_frozen");
      }
      return r;
    });
  }
  function postRestoreVerify(totpCode, revokeOtherSessions, opts) {
    var payload = { totp_code: totpCode, revokeOtherSessions: revokeOtherSessions !== false };
    if (opts && opts.expectedJobId) payload.expectedJobId = opts.expectedJobId;
    if (opts && opts.expectedSnapshotSha256) payload.expectedSnapshotSha256 = opts.expectedSnapshotSha256;
    return apiFetch("/api/admin/post-restore-verify", {
      method: "POST",
      body: payload,
    }).then(function (r) {
      if (r.ok) {
        state.restoreFrozen = false;
        state.syncStatus = computeHealthySyncStatus();
        emitChange("restore_unfrozen");
      }
      return r;
    });
  }

  // ===== Companies, Pool, Dedupe & OSM Raw Pool =====
  function listCompanies(params) {
    var p = params || {};
    var qs = new URLSearchParams();
    if (p.view) qs.set("view", p.view);
    if (p.country && p.country !== "ALL") qs.set("country", p.country);
    if (p.pool_stage && p.pool_stage !== "all") qs.set("pool_stage", p.pool_stage);
    if (p.contact_status && p.contact_status !== "all") qs.set("contact_status", p.contact_status);
    if (p.q) qs.set("q", p.q);
    qs.set("limit", String(Math.min(50, Math.max(1, p.limit || 30))));
    qs.set("offset", String(Math.max(0, p.offset || 0)));
    return apiFetch("/api/companies?" + qs.toString(), { method: "GET" });
  }

  function getCompany(id) {
    return apiFetch("/api/companies/" + encodeURIComponent(id), { method: "GET" });
  }

  function createCompany(payload) {
    return apiFetch("/api/companies", { method: "POST", body: payload });
  }

  function updateCompany(id, payload) {
    return apiFetch("/api/companies/" + encodeURIComponent(id), { method: "PATCH", body: payload });
  }

  function addCompanyContact(companyId, payload) {
    return apiFetch("/api/companies/" + encodeURIComponent(companyId) + "/contacts", { method: "POST", body: payload });
  }

  function dedupeBatch(items) {
    return apiFetch("/api/companies/dedupe-batch", { method: "POST", body: { items: items || [] } });
  }

  function mergeCompanies(sourceId, targetId) {
    return apiFetch("/api/companies/merge", { method: "POST", body: { source_id: sourceId, target_id: targetId } });
  }

  function unmergeCompany(auditId) {
    return apiFetch("/api/companies/unmerge", { method: "POST", body: { audit_id: auditId } });
  }

  function listOsmPool(country) {
    var q = country && country !== "ALL" ? "?country=" + encodeURIComponent(country) : "";
    return apiFetch("/api/osm-pool" + q, { method: "GET" });
  }

  function ingestOsmPool(items) {
    return apiFetch("/api/osm-pool/ingest", { method: "POST", body: { items: items || [] } });
  }

  function promoteOsmLead(osmId, payload) {
    return apiFetch("/api/osm-pool/" + encodeURIComponent(osmId) + "/promote", { method: "POST", body: payload || {} });
  }

  function saveQuoteRecord(companyId, payload) {
    return apiFetch("/api/companies/" + encodeURIComponent(companyId) + "/quotes", { method: "POST", body: payload });
  }

  function saveComplianceLog(companyId, payload) {
    return apiFetch("/api/companies/" + encodeURIComponent(companyId) + "/compliance-logs", { method: "POST", body: payload });
  }

  function logScrapeTask(payload) {
    return apiFetch("/api/scrape-tasks", { method: "POST", body: payload, trackSync: false });
  }

  // ===== Atomic Contact Locks (NEVER fake success offline!) =====
  function acquireLock(companyId, channel) {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return Promise.resolve({
        ok: false,
        offline: true,
        status: 0,
        data: {
          code: "OFFLINE_LOCK_FORBIDDEN",
          error: "🟡 当前处于离线状态，无法核对团队最新联系记录与防撞单锁，请联网确认后再主动触达客户！",
        },
      });
    }
    return apiFetch("/api/locks/acquire", {
      method: "POST",
      body: { company_id: companyId, channel: channel || "general" },
    }).then(function (r) {
      if (r.networkError) {
        return {
          ok: false,
          offline: true,
          status: 0,
          data: {
            code: "OFFLINE_LOCK_FORBIDDEN",
            error: "🟡 无法连接云端校验团队联系状态（防撞单锁未成功），请联网后再主动触达！",
          },
        };
      }
      if (r.ok && r.data && r.data.lock) {
        activeLocks[companyId] = r.data.lock;
        emitChange("lock_acquired");
      }
      return r;
    });
  }

  function releaseLock(companyId, lockId) {
    var lid = lockId || (activeLocks[companyId] && activeLocks[companyId].lock_id);
    if (!lid) return Promise.resolve({ ok: true });
    return apiFetch("/api/locks/release", {
      method: "POST",
      body: { company_id: companyId, lock_id: lid },
    }).then(function (r) {
      delete activeLocks[companyId];
      emitChange("lock_released");
      return r;
    });
  }

  // ===== Append-Only Contact Events + Lossless Idempotent Offline Queue (D01 & D02) =====
  function isTransientFailure(r) {
    if (!r) return true;
    if (r.revoked) return false;
    if (r.restoreFrozen || (r.data && r.data.code === "SYSTEM_RESTORE_FROZEN")) return false;
    return Boolean(r.networkError || r.status === 0 || r.status >= 500 || r.status === 429 || r.status === 408);
  }

  function enqueuePendingEvent(ev) {
    var q = loadPendingQueue();
    if (q.some(function (x) { return x && x.event_id === ev.event_id; })) {
      return { ok: true, count: q.length, duplicate: true };
    }
    if (q.length >= MAX_PENDING_QUEUE) {
      return {
        ok: false,
        queueFull: true,
        error: "⚠️ 本地离线待同步队列已满（上限 " + MAX_PENDING_QUEUE + " 条），禁止继续丢弃写入！请先恢复联网并点击「立即补传同步」。",
      };
    }
    q.push(ev);
    var saved = savePendingQueue(q);
    if (saved.ok) {
      idbQueuePutRecord({
        event_id: ev.event_id,
        status: "pending",
        event: ev,
        updatedAt: new Date().toISOString(),
      });
    }
    return saved;
  }

  // R01: Remove ONLY the settled event_id from fresh persisted queue (NEVER overwrite newly enqueued records!)
  function removePendingById(eventId) {
    var cur = loadPendingQueue();
    var next = cur.filter(function (x) { return !(x && x.event_id === eventId); });
    if (next.length === cur.length) {
      state.pendingCount = cur.length;
      return { ok: true, count: cur.length, existed: false };
    }
    return savePendingQueue(next);
  }

  // R02 / R03: Write durable failed copy FIRST (without truncation) and verify success BEFORE removing from pending!
  function transitionPendingToFailed(item, response) {
    var failed = loadFailedQueue();
    var exists = failed.some(function (f) { return f && f.event && f.event.event_id === item.event_id; });
    var entry = {
      event: item,
      status: (response && response.status) || 400,
      code: (response && response.data && response.data.code) || "SYNC_REJECTED",
      error: (response && response.data && response.data.error) || ("服务端拒绝该记录 (HTTP " + ((response && response.status) || 400) + ")"),
      failedAt: new Date().toISOString(),
    };
    if (!exists) {
      failed.push(entry);
    }
    var fSave = saveFailedQueue(failed);
    if (!fSave.ok) {
      // R03 HARD RULE: Failed queue write failed (e.g. QuotaExceeded) -> DO NOT delete original pending copy!
      state.pendingCount = loadPendingQueue().length;
      state.failedCount = loadFailedQueue().length;
      return { ok: false, storageError: true, error: fSave.error };
    }
    // Failed copy is now durably persisted; mirror atomic status flip in IndexedDB and remove from pending by ID
    idbQueuePutRecord({
      event_id: item.event_id,
      status: "rejected",
      event: item,
      statusCode: entry.status,
      code: entry.code,
      error: entry.error,
      failedAt: entry.failedAt,
      updatedAt: entry.failedAt,
    });
    var pSave = removePendingById(item.event_id);
    if (!pSave.ok) {
      // Failed copy is safely persisted; report storage error truthfully without claiming full cleanup
      return { ok: false, storageError: true, persistedInFailed: true, error: pSave.error };
    }
    return { ok: true, storageError: false };
  }

  function recordEvent(payload) {
    var ev = Object.assign({}, payload || {});
    if (!ev.event_id) ev.event_id = genStableEventId();
    if (!ev.occurred_at) ev.occurred_at = new Date().toISOString();
    var compId = ev.company_id;
    if (!ev.release_lock_id && compId && activeLocks[compId]) {
      ev.release_lock_id = activeLocks[compId].lock_id;
    }

    return apiFetch("/api/events", { method: "POST", body: ev }).then(function (r) {
      if (r.ok) {
        if (compId && activeLocks[compId]) delete activeLocks[compId];
        emitChange("event_saved");
        return r;
      }
      if (isTransientFailure(r)) {
        var enq = enqueuePendingEvent(ev);
        if (!enq.ok) {
          state.syncStatus = "error";
          state.lastError = enq.error;
          emitChange("queue_error");
          return {
            ok: false,
            queueFull: Boolean(enq.queueFull),
            storageFull: Boolean(enq.storageFull),
            status: r.status || 0,
            data: {
              code: enq.queueFull ? "OFFLINE_QUEUE_FULL" : "OFFLINE_STORAGE_FULL",
              error: enq.error,
            },
          };
        }
        state.syncStatus = r.networkError ? "offline" : "error";
        if (!r.networkError && r.data && r.data.error) state.lastError = r.data.error;
        emitChange("queued_offline");
        return {
          ok: false,
          queuedOffline: true,
          transientServerError: !r.networkError,
          status: r.status || 0,
          data: {
            event_id: ev.event_id,
            pendingCount: state.pendingCount,
            message: r.networkError
              ? "当前离线，已安全暂存为「待同步记录」（尚未写入云端库，恢复联网后按唯一 ID 幂等补传）"
              : "云端服务暂时异常（HTTP " + r.status + "），记录已安全保留在本地待同步队列，绝不丢失，稍后将自动补传",
          },
        };
      }
      return r;
    });
  }

  function withCrossTabFlushLock(fn) {
    if (typeof navigator !== "undefined" && navigator.locks && typeof navigator.locks.request === "function") {
      return navigator.locks.request("friesgo_cloud_queue_flush_v1", fn);
    }
    return fn();
  }

  function executeSingleFlushPass() {
    if (!state.session) {
      var pNow = loadPendingQueue();
      var fNow = loadFailedQueue();
      state.pendingCount = pNow.length;
      state.failedCount = fNow.length;
      return Promise.resolve({ flushed: 0, remaining: pNow.length, failed: fNow.length, storageError: false });
    }
    var initialPending = loadPendingQueue();
    var initialFailed = loadFailedQueue();
    if (!initialPending.length) {
      state.pendingCount = 0;
      state.failedCount = initialFailed.length;
      state.syncStatus = computeHealthySyncStatus();
      emitChange("queue_flushed");
      return Promise.resolve({ flushed: 0, remaining: 0, failed: initialFailed.length, storageError: false });
    }

    var attemptIds = initialPending
      .map(function (x) { return x && x.event_id; })
      .filter(Boolean);
    var flushed = 0;
    var hadTransientError = false;
    var hadStorageError = false;
    var lastErr = "";
    var abortedByRevoke = false;

    return attemptIds
      .reduce(function (chain, eid) {
        return chain.then(function () {
          if (abortedByRevoke || !state.session) return;
          // Re-read fresh storage before each item in case another tab or user action settled/cleared it
          var freshPending = loadPendingQueue();
          var item = null;
          for (var i = 0; i < freshPending.length; i++) {
            if (freshPending[i] && freshPending[i].event_id === eid) {
              item = freshPending[i];
              break;
            }
          }
          if (!item) return;

          return apiFetch("/api/events", { method: "POST", body: item, trackSync: false }).then(function (r) {
            if (r.revoked) {
              abortedByRevoke = true;
              return;
            }
            if (!state.session) {
              abortedByRevoke = true;
              return;
            }
            if (r.ok) {
              // R01: Remove ONLY this confirmed event_id from current persisted queue; preserve all concurrent additions!
              var rm = removePendingById(eid);
              if (rm.ok) {
                idbQueueDeleteIds([eid]);
                flushed++;
              } else {
                hadStorageError = true;
                lastErr = rm.error || "本地队列状态更新失败";
              }
            } else if (isTransientFailure(r) || r.restoreFrozen) {
              // D01: NEVER drop on 500/502/503/504/429/408/network error or restore freeze!
              if (!r.networkError) {
                hadTransientError = true;
                lastErr = (r.data && r.data.error) || ("云端暂时异常 (HTTP " + r.status + ")");
              }
            } else {
              // R02 / R03: Permanent 4xx -> persist full failed entry FIRST, remove pending ONLY if persistence succeeded!
              var tr = transitionPendingToFailed(item, r);
              if (!tr.ok) {
                hadStorageError = true;
                lastErr = tr.error || "失败队列持久化存储失败，原待同步记录已保留";
              } else {
                lastErr = (r.data && r.data.error) || ("HTTP " + r.status);
              }
            }
          });
        });
      }, Promise.resolve())
      .then(function () {
        if (abortedByRevoke || !state.session) {
          return { flushed: flushed, remaining: 0, failed: 0, revoked: true, storageError: hadStorageError };
        }
        // Always derive final counts & status strictly from PERSISTED storage truth (never stale snapshots!)
        var finalPending = loadPendingQueue();
        var finalFailed = loadFailedQueue();
        state.pendingCount = finalPending.length;
        state.failedCount = finalFailed.length;

        if (hadStorageError) {
          state.syncStatus = "error";
          state.lastError = lastErr || "本地存储受限，待同步记录已保留未丢失";
        } else if (finalPending.length > 0) {
          state.syncStatus = hadTransientError || state.restoreFrozen ? "error" : "offline";
          if (lastErr) state.lastError = lastErr;
        } else if (finalFailed.length > 0) {
          state.syncStatus = "error";
          state.lastError = "有 " + finalFailed.length + " 条离线记录同步被服务端拒绝，请点击查看详情";
        } else {
          state.syncStatus = state.restoreFrozen ? "error" : "synced";
          state.lastSyncedAt = new Date().toISOString();
          state.lastError = "";
        }
        emitChange("queue_flushed");
        return {
          flushed: flushed,
          remaining: finalPending.length,
          failed: finalFailed.length,
          storageError: hadStorageError,
          error: hadStorageError ? lastErr : "",
        };
      });
  }

  // R01: Serialized flush queue with cross-tab lock; concurrent flush calls chain cleanly without racing!
  function flushPendingQueue() {
    if (!state.session) return Promise.resolve({ flushed: 0, remaining: 0, failed: loadFailedQueue().length, storageError: false });
    if (flushInFlight) {
      flushRequestedAgain = true;
      return flushInFlight.then(function (prevRes) {
        if (!state.session || !flushRequestedAgain) return prevRes;
        flushRequestedAgain = false;
        return flushPendingQueue().then(function (nextRes) {
          return {
            flushed: (prevRes.flushed || 0) + (nextRes.flushed || 0),
            remaining: nextRes.remaining,
            failed: nextRes.failed,
            revoked: Boolean(prevRes.revoked || nextRes.revoked),
            storageError: Boolean(prevRes.storageError || nextRes.storageError),
            error: nextRes.error || prevRes.error || "",
          };
        });
      });
    }
    var run = withCrossTabFlushLock(executeSingleFlushPass);
    flushInFlight = run;
    return run.then(
      function (res) {
        if (flushInFlight === run) flushInFlight = null;
        return res;
      },
      function (err) {
        if (flushInFlight === run) flushInFlight = null;
        throw err;
      }
    );
  }

  function getPendingQueue() {
    return loadPendingQueue();
  }

  function getFailedQueue() {
    return loadFailedQueue();
  }

  function retryFailedQueue() {
    var failed = loadFailedQueue();
    if (!failed.length) return Promise.resolve({ flushed: 0, remaining: loadPendingQueue().length, failed: 0 });
    var pending = loadPendingQueue();
    var movedIds = [];
    var keptFailed = [];
    failed.forEach(function (f) {
      if (f && f.event && pending.length < MAX_PENDING_QUEUE) {
        if (!pending.some(function (p) { return p && p.event_id === f.event.event_id; })) {
          pending.push(f.event);
        }
        movedIds.push(f.event);
      } else {
        keptFailed.push(f);
      }
    });
    // Write pending copy FIRST; if storage fails, keep failed untouched!
    var saved = savePendingQueue(pending);
    if (!saved.ok) {
      state.syncStatus = "error";
      state.lastError = saved.error || "重传写回待同步队列失败";
      emitChange("queue_error");
      return Promise.resolve({ ok: false, storageError: true, error: saved.error, flushed: 0, remaining: loadPendingQueue().length, failed: failed.length });
    }
    var fSaved = saveFailedQueue(keptFailed);
    if (!fSaved.ok) {
      state.syncStatus = "error";
      state.lastError = fSaved.error || "更新失败队列存储失败";
      emitChange("queue_error");
      return Promise.resolve({ ok: false, storageError: true, error: fSaved.error, flushed: 0, remaining: loadPendingQueue().length, failed: loadFailedQueue().length });
    }
    movedIds.forEach(function (ev) {
      idbQueuePutRecord({ event_id: ev.event_id, status: "pending", event: ev, updatedAt: new Date().toISOString() });
    });
    emitChange("failed_requeued");
    return flushPendingQueue();
  }

  function dismissFailedItem(eventId) {
    var failed = loadFailedQueue();
    var next = failed.filter(function (f) { return !(f && f.event && f.event.event_id === eventId); });
    var saved = saveFailedQueue(next);
    if (!saved.ok) {
      state.syncStatus = "error";
      state.lastError = saved.error || "移除失败记录时存储写入失败";
      emitChange("queue_error");
      return loadFailedQueue().length;
    }
    idbQueueDeleteIds([eventId]);
    state.pendingCount = loadPendingQueue().length;
    state.syncStatus = computeHealthySyncStatus();
    if (!next.length && !state.pendingCount && !state.restoreFrozen) state.lastError = "";
    emitChange("failed_dismissed");
    return next.length;
  }

  function listRecentEvents(onlyMine) {
    return apiFetch("/api/events/recent?limit=40" + (onlyMine ? "&mine=1" : ""), { method: "GET" });
  }

  // ===== 6-Step Historical IndexedDB Migration =====
  function migrateDryRun(leads, complianceLogs) {
    return apiFetch("/api/migrate/dry-run", {
      method: "POST",
      body: { leads: leads || [], complianceLogs: complianceLogs || [] },
    });
  }

  function migrateCommit(batchId, leads, complianceLogs, decisions) {
    return apiFetch("/api/migrate/commit", {
      method: "POST",
      body: {
        batch_id: batchId,
        leads: leads || [],
        complianceLogs: complianceLogs || [],
        decisions: decisions || {},
      },
    });
  }

  // ===== Cloud Co-Creation Feedback Board =====
  function listCloudFeedback(status) {
    var q = status && status !== "all" ? "?status=" + encodeURIComponent(status) : "";
    return apiFetch("/api/feedback" + q, { method: "GET" });
  }
  function submitCloudFeedback(payload) {
    return apiFetch("/api/feedback", { method: "POST", body: payload });
  }
  function updateCloudFeedback(id, payload) {
    return apiFetch("/api/feedback/" + encodeURIComponent(id), { method: "PATCH", body: payload });
  }

  // ===== Authenticated Paid Google Maps Proxy & Quota =====
  function searchGmaps(textQuery, pageSize, pageToken) {
    return apiFetch("/api/gmaps/search", {
      method: "POST",
      body: { textQuery: textQuery, pageSize: pageSize || 20, pageToken: pageToken || "" },
    });
  }

  function getGmapsQuota() {
    return apiFetch("/api/gmaps/quota", { method: "GET", trackSync: false });
  }

  // Boot initialization: restore session & pending/failed counts (never dumps full company DB!)
  (function init() {
    var sess = loadSession();
    var pending = loadPendingQueue();
    var failed = loadFailedQueue();
    state.pendingCount = pending.length;
    state.failedCount = failed.length;
    if (sess) {
      state.session = sess;
      state.syncStatus = failed.length ? "error" : pending.length ? "offline" : "syncing";
      // Hydrate from IndexedDB mirror if localStorage lost queue entries while session is active
      if (!pending.length && !failed.length && typeof indexedDB !== "undefined") {
        idbQueueLoadAll().then(function (rows) {
          if (!state.session || !rows || !rows.length) return;
          var curP = loadPendingQueue();
          var curF = loadFailedQueue();
          var pAdded = false;
          var fAdded = false;
          rows.forEach(function (rec) {
            if (!rec || !rec.event || !rec.event_id) return;
            if (rec.status === "rejected") {
              if (!curF.some(function (x) { return x && x.event && x.event.event_id === rec.event_id; })) {
                curF.push({
                  event: rec.event,
                  status: rec.statusCode || 400,
                  code: rec.code || "SYNC_REJECTED",
                  error: rec.error || "同步被服务端拒绝",
                  failedAt: rec.failedAt || rec.updatedAt || new Date().toISOString(),
                });
                fAdded = true;
              }
            } else if (curP.length < MAX_PENDING_QUEUE) {
              if (!curP.some(function (x) { return x && x.event_id === rec.event_id; })) {
                curP.push(rec.event);
                pAdded = true;
              }
            }
          });
          if (pAdded) savePendingQueue(curP);
          if (fAdded) saveFailedQueue(curF);
          if (pAdded || fAdded) {
            state.syncStatus = computeHealthySyncStatus();
            emitChange("queue_hydrated");
          }
        });
      }
    } else {
      state.syncStatus = "guest";
    }
    if (typeof global.addEventListener === "function") {
      global.addEventListener("online", function () {
        if (state.session) flushPendingQueue();
      });
      global.addEventListener("offline", function () {
        if (state.session) {
          state.syncStatus = "offline";
          emitChange("offline");
        }
      });
      // Cross-tab sync: keep session logout/switch and queue counts consistent across tabs (R01/R07)
      global.addEventListener("storage", function (ev) {
        if (!ev || !ev.key) return;
        if (ev.key === SESSION_KEY) {
          var prevId = state.session && state.session.employee ? state.session.employee.id : "";
          var nextSess = loadSession();
          var nextId = nextSess && nextSess.employee ? nextSess.employee.id : "";
          state.session = nextSess;
          if (!nextSess) {
            activeLocks = Object.create(null);
            state.pendingCount = 0;
            state.failedCount = 0;
            state.syncStatus = "guest";
            state.restoreFrozen = false;
            emitChange("cleared");
          } else if (prevId && nextId && prevId !== nextId) {
            activeLocks = Object.create(null);
            state.pendingCount = loadPendingQueue().length;
            state.failedCount = loadFailedQueue().length;
            state.syncStatus = computeHealthySyncStatus();
            emitChange("account_switched");
          } else {
            state.syncStatus = computeHealthySyncStatus();
            emitChange("session_sync");
          }
        } else if (ev.key === PENDING_KEY || ev.key === FAILED_KEY) {
          state.pendingCount = loadPendingQueue().length;
          state.failedCount = loadFailedQueue().length;
          state.syncStatus = computeHealthySyncStatus();
          emitChange("queue_sync");
        }
      });
    }
  })();

  global.FG_CLOUD = {
    getApiBase: getApiBase,
    setApiBase: setApiBase,
    getHealth: getHealth,
    getState: getState,
    subscribe: subscribe,
    clearAllPrivateState: clearAllPrivateState,
    login: login,
    totpSetup: totpSetup,
    totpConfirm: totpConfirm,
    refreshMe: refreshMe,
    logout: logout,
    changePassword: changePassword,
    listOwnSessions: listOwnSessions,
    revokeOwnSession: revokeOwnSession,
    listEmployees: listEmployees,
    createEmployee: createEmployee,
    createEmployeesBatch: createEmployeesBatch,
    updateEmployee: updateEmployee,
    listEmployeeSessions: listEmployeeSessions,
    revokeEmployeeSessions: revokeEmployeeSessions,
    listAuditLogs: listAuditLogs,
    listRestoreJobs: listRestoreJobs,
    exportBackup: exportBackup,
    restoreBackup: restoreBackup,
    postRestoreVerify: postRestoreVerify,
    listCompanies: listCompanies,
    getCompany: getCompany,
    createCompany: createCompany,
    updateCompany: updateCompany,
    addCompanyContact: addCompanyContact,
    dedupeBatch: dedupeBatch,
    mergeCompanies: mergeCompanies,
    unmergeCompany: unmergeCompany,
    listOsmPool: listOsmPool,
    ingestOsmPool: ingestOsmPool,
    promoteOsmLead: promoteOsmLead,
    saveQuoteRecord: saveQuoteRecord,
    saveComplianceLog: saveComplianceLog,
    logScrapeTask: logScrapeTask,
    acquireLock: acquireLock,
    releaseLock: releaseLock,
    recordEvent: recordEvent,
    flushPendingQueue: flushPendingQueue,
    getPendingQueue: getPendingQueue,
    getFailedQueue: getFailedQueue,
    retryFailedQueue: retryFailedQueue,
    dismissFailedItem: dismissFailedItem,
    listRecentEvents: listRecentEvents,
    migrateDryRun: migrateDryRun,
    migrateCommit: migrateCommit,
    listCloudFeedback: listCloudFeedback,
    submitCloudFeedback: submitCloudFeedback,
    updateCloudFeedback: updateCloudFeedback,
    searchGmaps: searchGmaps,
    getGmapsQuota: getGmapsQuota,
  };
})(typeof window !== "undefined" ? window : globalThis);
