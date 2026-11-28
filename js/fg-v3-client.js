/* FriesGo Global V3.0 Slice 1: Multi-Tenant Context-Epoch API Client & Scoped Draft Isolation
 * Implements:
 *   - REV01: contextEpoch + AbortController (any org/role switch, logout, or 401 IMMEDIATELY aborts & discards stale in-flight requests!)
 *   - ACQ04: Drafts strictly namespaced by (employee_id, org_id, membership_id) so switching accounts/orgs never cross-uploads drafts.
 */
(function (global) {
  "use strict";

  var CONTEXT_KEY = "friesgo_v3_active_context_v1";
  var DRAFT_PREFIX = "friesgo_v3_draft_v1";

  var contextEpoch = 0;
  var activeControllers = new Set();
  var listeners = [];
  var v3State = {
    contexts: [],
    supportGrants: [],
    activeContext: null, // { org_id, org_type, org_name, role, membership_id, partner_ref_code }
    lastError: "",
  };

  function getApiBase() {
    if (global.FG_CLOUD && typeof global.FG_CLOUD.getApiBase === "function") {
      return global.FG_CLOUD.getApiBase();
    }
    if (global.FG_CLOUD_API_OVERRIDE) {
      return String(global.FG_CLOUD_API_OVERRIDE).replace(/\/+$/, "");
    }
    return "https://friesgo-api.ntigravity-project.workers.dev";
  }

  function getSession() {
    if (global.FG_CLOUD && typeof global.FG_CLOUD.getState === "function") {
      var st = global.FG_CLOUD.getState();
      if (!st || !st.loggedIn || !st.employee) return null;
      try {
        var raw = localStorage.getItem("friesgo_cloud_session_v1");
        var parsed = raw ? JSON.parse(raw) : null;
        if (parsed && parsed.token) {
          return {
            token: parsed.token,
            sessionId: st.sessionId || parsed.sessionId || "",
            employee: st.employee,
          };
        }
      } catch (_) {}
    }
    return null;
  }

  function notify() {
    var snap = getState();
    listeners.forEach(function (fn) {
      try { fn(snap); } catch (_) {}
    });
  }

  function abortAllInFlight() {
    activeControllers.forEach(function (ctrl) {
      try { ctrl.abort(); } catch (_) {}
    });
    activeControllers.clear();
  }

  function getState() {
    return {
      contextEpoch: contextEpoch,
      contexts: v3State.contexts.slice(),
      supportGrants: v3State.supportGrants.slice(),
      activeContext: v3State.activeContext ? Object.assign({}, v3State.activeContext) : null,
      lastError: v3State.lastError,
    };
  }

  function bumpEpochAndAbort() {
    contextEpoch += 1;
    abortAllInFlight();
    return contextEpoch;
  }

  function resetContextOnAuthChange() {
    bumpEpochAndAbort();
    v3State.contexts = [];
    v3State.supportGrants = [];
    v3State.activeContext = null;
    v3State.lastError = "";
    try { sessionStorage.removeItem(CONTEXT_KEY); } catch (_) {}
    notify();
  }

  function switchContext(nextCtx) {
    bumpEpochAndAbort();
    v3State.activeContext = nextCtx ? Object.assign({}, nextCtx) : null;
    v3State.lastError = "";
    try {
      if (nextCtx) sessionStorage.setItem(CONTEXT_KEY, JSON.stringify(nextCtx));
      else sessionStorage.removeItem(CONTEXT_KEY);
    } catch (_) {}
    notify();
    return contextEpoch;
  }

  function draftStorageKey(draftKind) {
    var ses = getSession();
    var empId = (ses && ses.employee && ses.employee.id) || "guest";
    var orgId = (v3State.activeContext && v3State.activeContext.org_id) || "no_org";
    var memId = (v3State.activeContext && v3State.activeContext.membership_id) || "no_mem";
    return [DRAFT_PREFIX, empId, orgId, memId, String(draftKind || "signal")].join("::");
  }

  function saveScopedDraft(draftKind, data) {
    try {
      localStorage.setItem(draftStorageKey(draftKind), JSON.stringify(data || {}));
    } catch (_) {}
  }

  function loadScopedDraft(draftKind) {
    try {
      var raw = localStorage.getItem(draftStorageKey(draftKind));
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function clearScopedDraft(draftKind) {
    try {
      localStorage.removeItem(draftStorageKey(draftKind));
    } catch (_) {}
  }

  /**
   * Context-epoch guarded fetch (REV01):
   * Captures current contextEpoch before dispatch, attaches X-FG-Org-Id / X-FG-Membership-Id,
   * aborts via AbortController on switch/logout, and strictly discards any response whose epoch no longer matches!
   */
  async function apiRequest(path, opts) {
    opts = opts || {};
    var ses = getSession();
    if (!ses || !ses.token) {
      return { ok: false, status: 401, code: "AUTH_REQUIRED", error: "请先登录成员账号" };
    }
    var reqEpoch = contextEpoch;
    var ctx = opts.overrideContext || v3State.activeContext;
    if (!opts.skipOrgHeader && (!ctx || !ctx.org_id)) {
      return { ok: false, status: 403, code: "ORG_CONTEXT_REQUIRED", error: "请先选择明确的数据空间上下文" };
    }

    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    if (ctrl) activeControllers.add(ctrl);

    var headers = {
      Authorization: "Bearer " + ses.token,
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (!opts.skipOrgHeader && ctx && ctx.org_id) {
      headers["X-FG-Org-Id"] = ctx.org_id;
      if (ctx.membership_id && ctx.membership_id !== "legacy_main") {
        headers["X-FG-Membership-Id"] = ctx.membership_id;
      }
    }
    if (opts.idemKey) headers["X-Idempotency-Key"] = String(opts.idemKey);

    try {
      var resp = await fetch(getApiBase() + path, {
        method: opts.method || "GET",
        headers: headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: ctrl ? ctrl.signal : undefined,
      });

      // REV01 HARD GUARD: If org/role switched or logged out while request was in flight, DISCARD immediately!
      if (reqEpoch !== contextEpoch) {
        return { ok: false, status: 0, aborted: true, staleContext: true, code: "STALE_CONTEXT_DISCARDED" };
      }

      if (resp.status === 401) {
        resetContextOnAuthChange();
      }

      var data = null;
      try { data = await resp.json(); } catch (_) { data = { ok: false, error: "Invalid JSON response" }; }
      if (reqEpoch !== contextEpoch) {
        return { ok: false, status: 0, aborted: true, staleContext: true, code: "STALE_CONTEXT_DISCARDED" };
      }
      return Object.assign({ status: resp.status }, data, { ok: Boolean(resp.ok && data && data.ok !== false) });
    } catch (err) {
      if (reqEpoch !== contextEpoch || (err && err.name === "AbortError")) {
        return { ok: false, status: 0, aborted: true, staleContext: true, code: "STALE_CONTEXT_DISCARDED" };
      }
      return { ok: false, status: 0, code: "NETWORK_ERROR", error: (err && err.message) || "网络连接中断，本地草稿已保留" };
    } finally {
      if (ctrl) activeControllers.delete(ctrl);
    }
  }

  async function loadContexts() {
    var res = await apiRequest("/api/v3/me/contexts", { skipOrgHeader: true });
    if (!res.ok) {
      v3State.lastError = res.error || "";
      notify();
      return res;
    }
    v3State.contexts = Array.isArray(res.contexts) ? res.contexts : [];
    v3State.supportGrants = Array.isArray(res.supportGrants) ? res.supportGrants : [];

    var saved = null;
    try {
      var raw = sessionStorage.getItem(CONTEXT_KEY);
      saved = raw ? JSON.parse(raw) : null;
    } catch (_) {}

    var matched = saved && v3State.contexts.find(function (c) {
      return c.org_id === saved.org_id && c.membership_id === saved.membership_id;
    });
    if (!matched && v3State.contexts.length === 1) {
      matched = v3State.contexts[0];
    }
    if (matched) {
      v3State.activeContext = Object.assign({}, matched);
    } else if (v3State.contexts.length > 0 && !v3State.activeContext) {
      // Explicit selection required when multiple contexts exist; default UI prompts user rather than guessing silently
      v3State.activeContext = null;
    }
    notify();
    return res;
  }

  // Subscribe to FG_CLOUD auth changes so logout / 401 / account switch ALWAYS bumps contextEpoch and clears V3 state!
  var lastEmpId = "";
  if (global.FG_CLOUD && typeof global.FG_CLOUD.subscribe === "function") {
    global.FG_CLOUD.subscribe(function (st) {
      var curEmp = (st && st.loggedIn && st.employee && st.employee.id) || "";
      if (!curEmp) {
        if (lastEmpId || v3State.activeContext || v3State.contexts.length) {
          lastEmpId = "";
          resetContextOnAuthChange();
        }
      } else if (curEmp !== lastEmpId) {
        lastEmpId = curEmp;
        resetContextOnAuthChange();
      }
    });
  }

  global.FG_V3 = {
    subscribe: function (fn) {
      if (typeof fn === "function") listeners.push(fn);
      return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
    },
    getState: getState,
    getContextEpoch: function () { return contextEpoch; },
    switchContext: switchContext,
    resetContextOnAuthChange: resetContextOnAuthChange,
    loadContexts: loadContexts,
    apiRequest: apiRequest,
    saveScopedDraft: saveScopedDraft,
    loadScopedDraft: loadScopedDraft,
    clearScopedDraft: clearScopedDraft,
    draftStorageKey: draftStorageKey,

    // Convenience wrappers
    listTasks: function () { return apiRequest("/api/v3/acq/tasks"); },
    createTask: function (body) { return apiRequest("/api/v3/acq/tasks", { method: "POST", body: body }); },
    patchTask: function (id, body) { return apiRequest("/api/v3/acq/tasks/" + encodeURIComponent(id), { method: "PATCH", body: body }); },
    listSignals: function (qs) { return apiRequest("/api/v3/acq/signals" + (qs ? "?" + qs : "")); },
    createSignal: function (body, idemKey) { return apiRequest("/api/v3/acq/signals", { method: "POST", body: body, idemKey: idemKey }); },
    auditSignal: function (id, body) { return apiRequest("/api/v3/acq/signals/" + encodeURIComponent(id) + "/audit", { method: "POST", body: body }); },
    generateDraft: function (id, body) { return apiRequest("/api/v3/acq/signals/" + encodeURIComponent(id) + "/draft", { method: "POST", body: body || {} }); },
    logContactAction: function (id, body) { return apiRequest("/api/v3/acq/signals/" + encodeURIComponent(id) + "/contact-action", { method: "POST", body: body }); },
    getSourceComparison: function (qs) { return apiRequest("/api/v3/acq/source-comparison" + (qs ? "?" + qs : "")); },
    listTodos: function (scope) { return apiRequest("/api/v3/dispatch/my-todos" + (scope ? "?scope=" + encodeURIComponent(scope) : "")); },
    assignDispatch: function (body, idemKey) { return apiRequest("/api/v3/dispatch/assign", { method: "POST", body: body, idemKey: idemKey }); },
    acceptDispatch: function (id, body, idemKey) { return apiRequest("/api/v3/dispatch/" + encodeURIComponent(id) + "/accept", { method: "POST", body: body || {}, idemKey: idemKey }); },
    rejectDispatch: function (id, body) { return apiRequest("/api/v3/dispatch/" + encodeURIComponent(id) + "/reject", { method: "POST", body: body }); },
    reassignDispatch: function (id, body) { return apiRequest("/api/v3/dispatch/" + encodeURIComponent(id) + "/reassign", { method: "POST", body: body }); },
    listProjects: function () { return apiRequest("/api/v3/projects"); },
    createProject: function (body) { return apiRequest("/api/v3/projects", { method: "POST", body: body }); },
    addProjectParticipant: function (pid, body) { return apiRequest("/api/v3/projects/" + encodeURIComponent(pid) + "/participants", { method: "POST", body: body }); },
    listDealRegs: function () { return apiRequest("/api/v3/partner/deal-reg"); },
    submitDealReg: function (body, idemKey) { return apiRequest("/api/v3/partner/deal-reg", { method: "POST", body: body, idemKey: idemKey }); },
    reviewDealReg: function (id, body) { return apiRequest("/api/v3/deal-reg/" + encodeURIComponent(id) + "/review", { method: "PATCH", body: body }); },
    listApplications: function () { return apiRequest("/api/v3/applications"); },
    reviewApplication: function (id, body) { return apiRequest("/api/v3/applications/" + encodeURIComponent(id), { method: "PATCH", body: body }); },
    activateApplication: function (id, body) { return apiRequest("/api/v3/applications/" + encodeURIComponent(id) + "/activate", { method: "POST", body: body }); },
    listCatalog: function () { return apiRequest("/api/v3/catalog"); },
    upsertCatalog: function (categoryKey, body) { return apiRequest("/api/v3/catalog/" + encodeURIComponent(categoryKey), { method: "PUT", body: body }); },
    listSupportGrants: function () { return apiRequest("/api/v3/support-grants"); },
    createSupportGrant: function (body) { return apiRequest("/api/v3/support-grants", { method: "POST", body: body }); },
    revokeSupportGrant: function (id) { return apiRequest("/api/v3/support-grants/" + encodeURIComponent(id), { method: "DELETE" }); },
    listCompanies: function (q) { return apiRequest("/api/v3/companies" + (q ? "?q=" + encodeURIComponent(q) : "")); },
    createCompany: function (body) { return apiRequest("/api/v3/companies", { method: "POST", body: body }); },
    optOutCompany: function (id, body) { return apiRequest("/api/v3/companies/" + encodeURIComponent(id) + "/opt-out", { method: "POST", body: body }); },
    listInquiries: function () { return apiRequest("/api/v3/inquiries"); },
    createInquiryQuote: function (id, body) { return apiRequest("/api/v3/inquiries/" + encodeURIComponent(id) + "/quote", { method: "POST", body: body }); },
    uploadAttachment: function (body) { return apiRequest("/api/v3/attachments", { method: "POST", body: body }); },
  };
})(typeof window !== "undefined" ? window : globalThis);
