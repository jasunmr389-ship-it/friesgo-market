/* FriesGo Global V2.1 M2-A: Cloud Company Pool, Employee Auth/2FA, Atomic Locks & Sync Client
 * Zero external dependencies. Works in desktop browsers, mobile Safari/Chrome & WeChat WebView (Bearer header, no 3rd-party cookies).
 */
(function (global) {
  "use strict";

  var DEFAULT_API_BASE = "https://friesgo-api.ntigravity-project.workers.dev";
  var SESSION_KEY = "friesgo_cloud_session_v1";
  var PENDING_KEY = "friesgo_cloud_pending_v1";
  var API_URL_KEY = "friesgo_cloud_api_url_v1";

  var listeners = [];
  var activeLocks = Object.create(null); // { [companyId]: { lock_id, expires_at, channel } }
  var state = {
    session: null, // { token, sessionId, expiresAt, employee, requireTotpSetup }
    syncStatus: "guest", // guest | synced | syncing | offline | error
    lastSyncedAt: "",
    lastError: "",
    pendingCount: 0,
  };

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
    var list = Array.isArray(arr) ? arr.slice(0, 200) : [];
    state.pendingCount = list.length;
    try {
      if (list.length) localStorage.setItem(PENDING_KEY, JSON.stringify(list));
      else localStorage.removeItem(PENDING_KEY);
    } catch (_) {}
  }

  /**
   * Immediately wipe all controllable private caches, tokens, pending queue & active locks
   * on logout OR server 401 SESSION_REVOKED_OR_DISABLED.
   */
  function clearAllPrivateState(reason) {
    saveSession(null);
    savePendingQueue([]);
    activeLocks = Object.create(null);
    state.syncStatus = "guest";
    state.lastSyncedAt = "";
    state.lastError = reason || "";
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
          if (res.ok) {
            if (state.session && o.trackSync !== false) {
              state.lastSyncedAt = new Date().toISOString();
              state.lastError = "";
              state.syncStatus = state.pendingCount > 0 ? "offline" : "synced";
              emitChange("synced");
            }
            return { ok: true, status: res.status, data: data };
          }
          if (state.session && o.trackSync !== false && res.status >= 500) {
            state.lastError = data.error || ("HTTP " + res.status);
            state.syncStatus = "error";
            emitChange("error");
          } else if (state.session && o.trackSync !== false) {
            state.syncStatus = state.pendingCount > 0 ? "offline" : "synced";
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

  // ===== Auth & 2FA =====
  function login(loginId, password, totpCode) {
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
        saveSession({
          token: r.data.token,
          sessionId: r.data.sessionId,
          expiresAt: r.data.expiresAt,
          employee: r.data.employee,
          requireTotpSetup: Boolean(r.data.requireTotpSetup),
        });
        state.syncStatus = "synced";
        state.lastSyncedAt = new Date().toISOString();
        state.lastError = "";
        emitChange("login");
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
  function exportBackup(totpCode) {
    return apiFetch("/api/admin/export-backup", { method: "POST", body: { totp_code: totpCode } });
  }
  function postRestoreVerify(totpCode, revokeOtherSessions) {
    return apiFetch("/api/admin/post-restore-verify", {
      method: "POST",
      body: { totp_code: totpCode, revokeOtherSessions: revokeOtherSessions !== false },
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

  function dedupeBatch(items) {
    return apiFetch("/api/companies/dedupe-batch", { method: "POST", body: { items: items || [] } });
  }

  function mergeCompanies(sourceId, targetId) {
    return apiFetch("/api/companies/merge", { method: "POST", body: { source_id: sourceId, target_id: targetId } });
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
          error: "🟡 当前处于离线状态，无法核对全员最新联系记录与防撞单锁，请联网确认后再主动触达客户！",
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
            error: "🟡 无法连接云端校验全员联系状态（防撞单锁未成功），请联网后再主动触达！",
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

  // ===== Append-Only Contact Events + Idempotent Offline Queue =====
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
      if (r.networkError) {
        var q = loadPendingQueue();
        if (!q.some(function (x) { return x.event_id === ev.event_id; })) {
          q.push(ev);
          savePendingQueue(q);
        }
        state.syncStatus = "offline";
        emitChange("queued_offline");
        return {
          ok: false,
          queuedOffline: true,
          data: {
            event_id: ev.event_id,
            message: "当前离线，已暂存为「待同步记录」（尚未写入公司云端库，恢复联网后将按唯一 ID 自动幂等补传）",
          },
        };
      }
      return r;
    });
  }

  function flushPendingQueue() {
    if (!state.session) return Promise.resolve({ flushed: 0, remaining: 0 });
    var q = loadPendingQueue();
    if (!q.length) {
      state.pendingCount = 0;
      if (state.syncStatus === "offline") {
        state.syncStatus = "synced";
        emitChange("synced");
      }
      return Promise.resolve({ flushed: 0, remaining: 0 });
    }
    var remaining = [];
    var flushed = 0;
    return q
      .reduce(function (chain, item) {
        return chain.then(function () {
          return apiFetch("/api/events", { method: "POST", body: item }).then(function (r) {
            if (r.ok) flushed++;
            else if (r.networkError) remaining.push(item);
          });
        });
      }, Promise.resolve())
      .then(function () {
        savePendingQueue(remaining);
        if (!remaining.length && state.session) {
          state.syncStatus = "synced";
          state.lastSyncedAt = new Date().toISOString();
        }
        emitChange("queue_flushed");
        return { flushed: flushed, remaining: remaining.length };
      });
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

  // ===== Authenticated Paid Google Maps Proxy =====
  function searchGmaps(textQuery, pageSize, pageToken) {
    return apiFetch("/api/gmaps/search", {
      method: "POST",
      body: { textQuery: textQuery, pageSize: pageSize || 20, pageToken: pageToken || "" },
    });
  }

  // Boot initialization: restore session & pending count (never dumps full company DB!)
  (function init() {
    var sess = loadSession();
    var pending = loadPendingQueue();
    state.pendingCount = pending.length;
    if (sess) {
      state.session = sess;
      state.syncStatus = pending.length ? "offline" : "syncing";
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
    }
  })();

  global.FG_CLOUD = {
    getApiBase: getApiBase,
    setApiBase: setApiBase,
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
    updateEmployee: updateEmployee,
    listEmployeeSessions: listEmployeeSessions,
    revokeEmployeeSessions: revokeEmployeeSessions,
    listAuditLogs: listAuditLogs,
    exportBackup: exportBackup,
    postRestoreVerify: postRestoreVerify,
    listCompanies: listCompanies,
    getCompany: getCompany,
    createCompany: createCompany,
    updateCompany: updateCompany,
    dedupeBatch: dedupeBatch,
    mergeCompanies: mergeCompanies,
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
    listRecentEvents: listRecentEvents,
    migrateDryRun: migrateDryRun,
    migrateCommit: migrateCommit,
    listCloudFeedback: listCloudFeedback,
    submitCloudFeedback: submitCloudFeedback,
    updateCloudFeedback: updateCloudFeedback,
    searchGmaps: searchGmaps,
  };
})(typeof window !== "undefined" ? window : globalThis);
