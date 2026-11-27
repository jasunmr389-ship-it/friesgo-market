/* FriesGo Global V2.1 M2-A: Cloud Workspace UI Controller
 * Mounts cleanly onto index.html anchors without disrupting public/offline tools or adding a 6th top-level nav.
 * Strict XSS escaping (escHtml), mobile 390px 0px overflow, dark mode aware, zero unauthenticated cloud calls.
 */
(function (global) {
  "use strict";

  function esc(s) {
    if (global.FG_CORE && typeof global.FG_CORE.escHtml === "function") {
      return global.FG_CORE.escHtml(s);
    }
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function toast(msg) {
    if (typeof global.showToast === "function") global.showToast(msg);
  }

  // S07: Unified Beijing Time (UTC+8) formatter — never expose raw UTC timestamps to business users
  function fmtBjt(iso, opts) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso).slice(0, 16).replace("T", " ");
    var bjt = new Date(d.getTime() + 8 * 3600 * 1000);
    var yyyy = bjt.getUTCFullYear();
    var mm = String(bjt.getUTCMonth() + 1).padStart(2, "0");
    var dd = String(bjt.getUTCDate()).padStart(2, "0");
    var hh = String(bjt.getUTCHours()).padStart(2, "0");
    var mi = String(bjt.getUTCMinutes()).padStart(2, "0");
    var o = opts || {};
    if (o.dateOnly) return yyyy + "-" + mm + "-" + dd;
    if (o.timeOnly) return hh + ":" + mi + " (UTC+8)";
    return yyyy + "-" + mm + "-" + dd + " " + hh + ":" + mi + " (UTC+8)";
  }

  // Naming Plan A: user-facing role labels
  function roleLabel(role) {
    if (role === "super_admin") return "总负责人";
    if (role === "manager") return "业务主管";
    return "业务成员";
  }

  function wirePwdToggleButtons(root) {
    if (!root) return;
    root.querySelectorAll("[data-toggle-pwd]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var inp = document.getElementById(btn.getAttribute("data-toggle-pwd"));
        if (!inp) return;
        var showing = inp.type === "text";
        inp.type = showing ? "password" : "text";
        btn.textContent = showing ? "👁️ 显示" : "🙈 隐藏";
      });
    });
  }

  var STATUS_LABELS = {
    uncontacted: { txt: "未联系", cls: "meta-pill" },
    preparing: { txt: "🔒 同事准备联系", cls: "mx-warn" },
    contacted_no_reply: { txt: "已联系未回复", cls: "action-tag" },
    following_up: { txt: "跟进中", cls: "fta-tag" },
    inquired: { txt: "已询盘", cls: "mx-ok" },
    quoted: { txt: "已报价", cls: "mx-ok" },
    stopped: { txt: "⛔ 停止联系/禁发", cls: "comp-tag comp-red" },
  };

  var POOL_STAGE_LABELS = {
    raw_pending: "待核实线索",
    verified_pool: "有效公海",
    active: "跟进中",
  };

  var COMP_STATUS_LABELS = {
    unchecked: "未背调",
    review: "复核中",
    approved: "✅ 已审批通过",
    blocked: "⛔ 合规阻断",
  };

  var FB_STATUS_LABELS = {
    open: { txt: "待评估", cls: "meta-pill" },
    planned: { txt: "已采纳排期", cls: "action-tag" },
    shipped: { txt: "✅ 已上线", cls: "mx-ok" },
    declined: { txt: "暂不采纳", cls: "src-ok" },
  };

  var uiState = {
    crmMode: "local", // pool | mine | team | osm | local
    pageOffset: 0,
    pageLimit: 30,
    total: 0,
    items: [],
    bindingCache: [],
    bindingTotal: 0,
    bindingLoadedAt: 0,
    lastMergeAuditId: "",
    selectedCompanyId: "",
    selectedDetail: null,
    activeLockCtx: null,
    migLocalData: null,
    migDryRun: null,
    migBackedUp: false,
  };

  function notifyCrossModuleRefresh() {
    if (typeof global._refreshCloudBoundModules === "function") {
      try {
        global._refreshCloudBoundModules(uiState.bindingCache, uiState.bindingTotal);
      } catch (_) {}
    }
  }

  function fetchCloudCompaniesForBinding(force) {
    var st = global.FG_CLOUD ? global.FG_CLOUD.getState() : { loggedIn: false };
    if (!st.loggedIn || st.requireTotpSetup) {
      uiState.bindingCache = [];
      uiState.bindingTotal = 0;
      notifyCrossModuleRefresh();
      return Promise.resolve([]);
    }
    if (!force && uiState.bindingLoadedAt && (Date.now() - uiState.bindingLoadedAt) < 15000 && uiState.bindingCache.length) {
      notifyCrossModuleRefresh();
      return Promise.resolve(uiState.bindingCache);
    }
    return global.FG_CLOUD.listCompanies({ view: "pool", limit: 50, offset: 0 }).then(function (r) {
      if (r.ok && r.data && Array.isArray(r.data.items)) {
        uiState.bindingCache = r.data.items;
        uiState.bindingTotal = Number(r.data.total || r.data.items.length);
        uiState.bindingLoadedAt = Date.now();
        notifyCrossModuleRefresh();
        return uiState.bindingCache;
      }
      return uiState.bindingCache;
    });
  }

  function injectModalsOnce() {
    if (document.getElementById("cloudAuthModal")) return;
    var holder = document.createElement("div");
    holder.innerHTML =
      // 1. Auth & Account / 2FA Modal (Naming Plan A)
      '<div id="cloudAuthModal" class="fg-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="cloudAuthTitle" hidden>'
      + '<div class="fg-modal-dialog">'
      + '  <div class="fg-modal-head">'
      + '    <h3 id="cloudAuthTitle">🔐 FriesGo 团队工作台登录与安全</h3>'
      + '    <button type="button" class="pill" data-close-modal="cloudAuthModal" style="min-height:28px;padding:2px 9px;font-size:12px">× 关闭</button>'
      + '  </div>'
      + '  <div id="cloudAuthBody"></div>'
      + '</div></div>'

      // 2. Atomic Contact Lock & Anti-Duplicate Coordination Modal
      + '<div id="cloudLockModal" class="fg-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="cloudLockTitle" hidden>'
      + '<div class="fg-modal-dialog">'
      + '  <div class="fg-modal-head">'
      + '    <h3 id="cloudLockTitle">🔒 防重复联系确认与结果记录</h3>'
      + '    <button type="button" class="pill" id="btnCloudLockClose" style="min-height:28px;padding:2px 9px;font-size:12px">× 关闭</button>'
      + '  </div>'
      + '  <div id="cloudLockBody"></div>'
      + '</div></div>'

      // 3. 6-Step Safe IndexedDB -> Cloud Migration Modal
      + '<div id="cloudMigrateModal" class="fg-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="cloudMigTitle" hidden>'
      + '<div class="fg-modal-dialog" style="max-width:680px">'
      + '  <div class="fg-modal-head">'
      + '    <h3 id="cloudMigTitle">📤 本机历史客户 6 步安全迁入云端公海库</h3>'
      + '    <button type="button" class="pill" data-close-modal="cloudMigrateModal" style="min-height:28px;padding:2px 9px;font-size:12px">× 关闭</button>'
      + '  </div>'
      + '  <div id="cloudMigrateBody"></div>'
      + '</div></div>'

      // 4. Super-Admin / Manager Governance Modal (Naming Plan A)
      + '<div id="cloudAdminModal" class="fg-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="cloudAdminTitle" hidden>'
      + '<div class="fg-modal-dialog" style="max-width:760px">'
      + '  <div class="fg-modal-head">'
      + '    <h3 id="cloudAdminTitle">🛡️ 成员权限、设备与备份管理</h3>'
      + '    <button type="button" class="pill" data-close-modal="cloudAdminModal" style="min-height:28px;padding:2px 9px;font-size:12px">× 关闭</button>'
      + '  </div>'
      + '  <div id="cloudAdminBody"></div>'
      + '</div></div>';
    document.body.appendChild(holder);

    ["cloudAuthModal", "cloudLockModal", "cloudMigrateModal", "cloudAdminModal"].forEach(function (mid) {
      var el = document.getElementById(mid);
      if (!el) return;
      el.addEventListener("click", function (e) {
        if (e.target === el) el.hidden = true;
      });
    });
    document.querySelectorAll("[data-close-modal]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var target = document.getElementById(btn.getAttribute("data-close-modal"));
        if (target) target.hidden = true;
      });
    });
    var lockClose = document.getElementById("btnCloudLockClose");
    if (lockClose) {
      lockClose.addEventListener("click", function () {
        document.getElementById("cloudLockModal").hidden = true;
      });
    }
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      ["cloudAuthModal", "cloudLockModal", "cloudMigrateModal", "cloudAdminModal"].forEach(function (mid) {
        var el = document.getElementById(mid);
        if (el && !el.hidden) el.hidden = true;
      });
    });
  }

  // ===== Topbar & Mobile Footer Sync Pill (Plan A + S09 compact mobile pill) =====
  function renderTopbarAuthState(st) {
    var btn = document.getElementById("btnCloudAuth");
    var footBtn = document.getElementById("btnFooterCloudAuth");
    var isNarrow = typeof window !== "undefined" && window.innerWidth <= 480;
    var txt = "🔒 成员登录";
    var fullTxt = "🔒 成员登录";
    var cls = "pill";
    if (st.loggedIn && st.employee) {
      var nm = st.employee.display_name || st.employee.login_id;
      var shortNm = isNarrow && nm.length > 4 ? (nm.slice(0, 4) + "…") : nm;
      if (st.requireTotpSetup) {
        fullTxt = "⚠️ 请绑定 2FA · " + nm;
        txt = isNarrow ? ("⚠️ 绑2FA · " + shortNm) : fullTxt;
        cls = "pill danger";
      } else if (st.restoreFrozen) {
        fullTxt = "🔒 恢复冻结中 · " + nm;
        txt = isNarrow ? "🔒 恢复冻结" : fullTxt;
        cls = "pill danger";
      } else if (st.syncStatus === "syncing") {
        fullTxt = "🔄 同步中 · " + nm;
        txt = isNarrow ? ("🔄 " + shortNm) : fullTxt;
        cls = "pill";
      } else if (st.syncStatus === "offline") {
        fullTxt = "🟡 离线" + (st.pendingCount ? ("(待传" + st.pendingCount + ")") : "") + " · " + nm;
        txt = isNarrow ? ("🟡 离线" + (st.pendingCount ? ("(" + st.pendingCount + ")") : "")) : fullTxt;
        cls = "pill";
      } else if (st.syncStatus === "error") {
        var errBadge = st.failedCount ? ("失败" + st.failedCount) : (st.pendingCount ? ("待传" + st.pendingCount) : "异常");
        fullTxt = "🔴 同步" + errBadge + " · " + nm;
        txt = isNarrow ? ("🔴 " + errBadge) : fullTxt;
        cls = "pill danger";
      } else {
        fullTxt = "🟢 " + nm;
        txt = "🟢 " + shortNm;
        cls = "pill good-btn";
      }
    }
    if (btn) {
      btn.textContent = txt;
      btn.title = fullTxt;
      btn.className = cls;
    }
    if (footBtn) {
      footBtn.textContent = st.loggedIn ? fullTxt : "🔒 成员登录";
    }

    // Toggle cloud pool shell inside #tools
    var cloudBar = document.getElementById("cloudPoolBar");
    var cloudView = document.getElementById("cloudPoolView");
    var localCard = document.getElementById("localCrmCardWrap");
    if (cloudBar) {
      cloudBar.hidden = !st.loggedIn || st.requireTotpSetup;
    }
    if (!st.loggedIn || st.requireTotpSetup) {
      uiState.crmMode = "local";
      uiState.bindingCache = [];
      uiState.bindingTotal = 0;
      if (cloudView) cloudView.hidden = true;
      if (localCard) localCard.hidden = false;
      notifyCrossModuleRefresh();
    } else {
      if (uiState.crmMode === "local") uiState.crmMode = "pool";
      syncCrmModeVisibility();
    }

    var fbCloudSec = document.getElementById("fbCloudSection");
    if (fbCloudSec) {
      fbCloudSec.hidden = !st.loggedIn || st.requireTotpSetup;
    }
    var gmapsHint = document.getElementById("gmapsCloudAutoHint");
    if (gmapsHint) {
      gmapsHint.hidden = !st.loggedIn || st.requireTotpSetup;
    }
    if (typeof global._refreshCloudGmapsQuota === "function") {
      try { global._refreshCloudGmapsQuota(); } catch (_) {}
    }
  }

  function syncCrmModeVisibility() {
    var st = global.FG_CLOUD.getState();
    var cloudView = document.getElementById("cloudPoolView");
    var localCard = document.getElementById("localCrmCardWrap");
    var isCloudMode = st.loggedIn && !st.requireTotpSetup && uiState.crmMode !== "local";
    if (cloudView) cloudView.hidden = !isCloudMode;
    if (localCard) localCard.hidden = isCloudMode;

    var bar = document.getElementById("cloudPoolModePills");
    if (bar) {
      bar.querySelectorAll("button[data-cmode]").forEach(function (b) {
        b.setAttribute("aria-pressed", b.getAttribute("data-cmode") === uiState.crmMode ? "true" : "false");
      });
    }
    var syncLine = document.getElementById("cloudSyncStatusLine");
    if (syncLine && st.loggedIn) {
      var ts = st.lastSyncedAt ? fmtBjt(st.lastSyncedAt, { timeOnly: true }) : "尚未拉取";
      var pwdHintBtn = (st.employee && st.employee.must_reset_pwd)
        ? ' <button type="button" class="pill" id="btnCloudQuickPwd" style="min-height:24px;padding:1px 8px;font-size:11.5px;border-color:var(--orange);color:var(--brown)">🔑 建议修改初始密码</button>'
        : '';
      var failedBtn = st.failedCount > 0
        ? ' <button type="button" class="pill danger" id="btnCloudInspectFailed" style="min-height:24px;padding:1px 8px;font-size:11.5px">⚠️ 查看失败记录 (' + st.failedCount + ')</button>'
        : '';

      if (st.restoreFrozen) {
        syncLine.innerHTML = '🔒 <b>系统恢复冻结保护中：</b>总负责人刚执行了云端备份恢复，正在等待「恢复后安全重核验」解冻（当前暂停业务写入，防止退订/停用数据回退）。'
          + (st.employee && st.employee.role === "super_admin"
              ? ' <button type="button" class="pill danger" id="btnCloudOpenAdminUnfreeze" style="min-height:24px;padding:1px 8px;font-size:11.5px">🛡️ 去管理后台重核验解冻</button>'
              : '');
      } else if (st.syncStatus === "offline") {
        syncLine.innerHTML = '🟡 <b>当前离线</b>（本地待同步 <b>' + st.pendingCount + '</b>/' + (st.maxPendingQueue || 200) + ' 条，尚未写入云端库；离线期间禁止宣告防撞单锁成功）'
          + ' <button type="button" class="pill" id="btnCloudRetrySync" style="min-height:24px;padding:1px 8px;font-size:11.5px">立即补传同步</button>'
          + failedBtn + pwdHintBtn;
      } else if (st.syncStatus === "error") {
        syncLine.innerHTML = '🔴 <b>同步待处理：</b>' + esc(st.lastError || "网络或云端异常")
          + (st.pendingCount ? ('（本地已安全保留 <b>' + st.pendingCount + '</b> 条待传记录）') : '')
          + ' <button type="button" class="pill" id="btnCloudRetrySync" style="min-height:24px;padding:1px 8px;font-size:11.5px">点击重试同步</button>'
          + failedBtn + pwdHintBtn;
      } else {
        syncLine.innerHTML = '🟢 <b>云端权威公海已同步</b>（最近同步 ' + esc(ts) + ' · 当前成员：' + esc(st.employee.display_name) + ' / ' + esc(roleLabel(st.employee.role)) + '）' + pwdHintBtn;
      }

      var retryBtn = document.getElementById("btnCloudRetrySync");
      if (retryBtn) {
        retryBtn.addEventListener("click", function () {
          global.FG_CLOUD.flushPendingQueue().then(function (r) {
            if (r.remaining > 0) toast("⚠️ 仍有 " + r.remaining + " 条待同步（已安全保留，未丢失）");
            else if (r.failed > 0) toast("⚠️ 有 " + r.failed + " 条被服务端拒绝，请点击查看失败记录");
            else toast("✅ 本地队列已全部同步至公司云端！");
            loadCloudActiveTab();
          });
        });
      }
      var quickPwdBtn = document.getElementById("btnCloudQuickPwd");
      if (quickPwdBtn) {
        quickPwdBtn.addEventListener("click", function () { openAuthModal({ expandPwd: true }); });
      }
      var unfreezeBtn = document.getElementById("btnCloudOpenAdminUnfreeze");
      if (unfreezeBtn) {
        unfreezeBtn.addEventListener("click", function () { openAdminModal("backup"); });
      }
      var inspFailedBtn = document.getElementById("btnCloudInspectFailed");
      if (inspFailedBtn) {
        inspFailedBtn.addEventListener("click", renderFailedQueueInspector);
      }
    }
  }

  function renderFailedQueueInspector() {
    var box = document.getElementById("cloudPoolDetailBox");
    if (!box) return;
    var failed = global.FG_CLOUD.getFailedQueue();
    box.hidden = false;
    if (!failed.length) {
      box.innerHTML = '<div class="v2-guard-bar lv-green">✅ 当前没有同步失败的离线记录。</div>';
      return;
    }
    box.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">'
      + '  <h3 style="margin:0;color:var(--danger)">⚠️ 离线同步被拒绝记录（共 ' + failed.length + ' 条，已完整保留未丢失）</h3>'
      + '  <div class="pills" style="margin:0">'
      + '    <button type="button" class="pill primary" id="btnRetryAllFailed" style="min-height:28px;padding:2px 10px;font-size:12px">🔄 全部重新补传</button>'
      + '    <button type="button" class="pill" id="btnCloseFailedBox" style="min-height:28px;padding:2px 8px;font-size:12px">× 收起</button>'
      + '  </div>'
      + '</div>'
      + '<div class="fb-log-list" style="margin-top:8px">'
      + failed.map(function (f) {
          var ev = f.event || {};
          return '<div class="fb-log-item" style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap">'
            + '<div><b>[' + esc(ev.channel || "event") + ' / ' + esc(ev.action_outcome || "") + ']</b> ' + esc(ev.summary || "（无摘要）")
            + '<div style="color:var(--danger);font-size:12px;margin-top:2px">原因 (HTTP ' + esc(f.status) + ')：' + esc(f.error) + '</div>'
            + '<div class="src-ok">事件 ID：' + esc(ev.event_id) + ' · 失败于 ' + esc(fmtBjt(f.failedAt)) + '</div></div>'
            + '<button type="button" class="pill" data-dismiss-failed="' + esc(ev.event_id) + '" style="min-height:26px;padding:2px 8px;font-size:11.5px">移除此条</button>'
            + '</div>';
        }).join("")
      + '</div>';
    document.getElementById("btnCloseFailedBox").addEventListener("click", function () { box.hidden = true; });
    document.getElementById("btnRetryAllFailed").addEventListener("click", function () {
      global.FG_CLOUD.retryFailedQueue().then(function (r) {
        toast("重传完成：成功 " + (r.flushed || 0) + " 条，待传 " + (r.remaining || 0) + " 条，仍失败 " + (r.failed || 0) + " 条");
        renderFailedQueueInspector();
        loadCloudActiveTab();
      });
    });
    box.querySelectorAll("[data-dismiss-failed]").forEach(function (b) {
      b.addEventListener("click", function () {
        global.FG_CLOUD.dismissFailedItem(b.getAttribute("data-dismiss-failed"));
        renderFailedQueueInspector();
        syncCrmModeVisibility();
      });
    });
  }

  // ===== 1. Auth / 2FA / Account Modal =====
  function openAuthModal(opts) {
    injectModalsOnce();
    var modal = document.getElementById("cloudAuthModal");
    modal.hidden = false;
    renderAuthModalBody(opts);
  }

  function renderAuthModalBody(extraState) {
    var body = document.getElementById("cloudAuthBody");
    if (!body) return;
    var st = global.FG_CLOUD.getState();

    // Case A: Logged in as super_admin who MUST complete mandatory 2FA enrollment
    if (st.loggedIn && st.requireTotpSetup) {
      body.innerHTML =
        '<div class="v2-guard-bar lv-red"><b>🛡️ 总负责人强制双重身份验证（2FA）绑定：</b>按安全铁律，总负责人必须先在手机验证器 App（Google / Microsoft Authenticator 或 iPhone 密码）完成 6 位动态码绑定，才能访问公海库与管理权限。</div>'
        + '<div class="pills" style="margin:8px 0"><button type="button" class="pill primary" id="btnStartTotpSetup">① 生成 2FA 密钥与 8 组应急恢复码</button></div>'
        + '<div id="totpSetupOutput"></div>'
        + '<div id="totpConfirmBox" hidden style="margin-top:10px;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--surface2)">'
        + '  <label for="inpTotpConfirmCode" style="display:block;font-size:12px;font-weight:800;color:var(--brown);margin-bottom:4px">② 输入手机验证器当前显示的 6 位动态验证码：</label>'
        + '  <div style="display:flex;gap:8px;flex-wrap:wrap">'
        + '    <input id="inpTotpConfirmCode" type="text" inputmode="numeric" maxlength="6" placeholder="例如 123456" style="flex:1;min-width:140px;min-height:36px;padding:4px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink)">'
        + '    <button type="button" class="pill primary" id="btnConfirmTotp">确认启用 2FA</button>'
        + '  </div>'
        + '</div>'
        + '<div style="margin-top:12px;text-align:right"><button type="button" class="pill" id="btnAuthLogout">退出登录</button></div>';

      document.getElementById("btnStartTotpSetup").addEventListener("click", function () {
        global.FG_CLOUD.totpSetup().then(function (r) {
          if (!r.ok) { toast(r.data.error || "生成失败"); return; }
          var d = r.data;
          var out = document.getElementById("totpSetupOutput");
          out.innerHTML =
            '<div class="fb-ctx-box" style="color:var(--ink)">'
            + '<div><b>手动录入密钥（Base32）：</b><code>' + esc(d.secretBase32) + '</code></div>'
            + '<div style="margin-top:4px"><b>一键唤起验证器：</b><a href="' + esc(d.otpauthUri) + '" style="color:var(--orange);font-weight:700;word-break:break-all">点击用本机验证器 App 打开</a></div>'
            + '<div style="margin-top:8px"><b>⚠️ 8 组一次性应急恢复码（仅展示这一次，请立刻抄存离线保管）：</b></div>'
            + '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:4px;margin-top:4px;font-family:monospace;font-weight:800">'
            + (d.recoveryCodes || []).map(function (c) { return '<div>' + esc(c) + '</div>'; }).join("")
            + '</div></div>';
          document.getElementById("totpConfirmBox").hidden = false;
        });
      });

      document.getElementById("btnConfirmTotp").addEventListener("click", function () {
        var code = document.getElementById("inpTotpConfirmCode").value.trim();
        global.FG_CLOUD.totpConfirm(code).then(function (r) {
          if (!r.ok) { toast(r.data.error || "验证码不匹配"); return; }
          toast("✅ 总负责人 2FA 已启用，欢迎进入 FriesGo 团队云端工作台！");
          document.getElementById("cloudAuthModal").hidden = true;
          loadCloudActiveTab();
          fetchCloudCompaniesForBinding(true);
        });
      });

      document.getElementById("btnAuthLogout").addEventListener("click", function () {
        global.FG_CLOUD.logout().then(function () {
          toast("已退出登录并清除本机私有会话");
          document.getElementById("cloudAuthModal").hidden = true;
        });
      });
      return;
    }

    // Case B: Logged in normally -> Account, Sync, Device Sessions & Admin Shortcuts
    if (st.loggedIn && st.employee) {
      var emp = st.employee;
      var isAdmin = emp.role === "super_admin" || emp.role === "manager";
      var openPwdDrawer = Boolean((extraState && extraState.expandPwd) || emp.must_reset_pwd);
      body.innerHTML =
        '<div class="v2-guard-bar lv-green"><b>👤 当前成员：</b>' + esc(emp.display_name) + '（登录名 <code>' + esc(emp.login_id) + '</code> · 角色 <b>' + esc(roleLabel(emp.role)) + '</b>）'
        + (emp.must_reset_pwd ? '<div style="color:var(--brown);font-weight:800;margin-top:4px">💡 您当前使用的是初始密码，建议在下方修改为个人专属密码（不阻断当前业务使用）。</div>' : '')
        + '</div>'
        + '<div class="pills" style="margin:8px 0">'
        + '  <button type="button" class="pill primary" id="btnOpenMigrateFromAuth">📤 6 步迁入本机历史客户</button>'
        + (isAdmin ? '  <button type="button" class="pill good-btn" id="btnOpenAdminFromAuth">🛡️ 成员权限 / 设备与备份管理</button>' : '')
        + '  <button type="button" class="pill danger" id="btnAuthLogout">🚪 安全退出（清本机私有缓存）</button>'
        + '</div>'
        + '<details class="adv-drawer" style="margin-top:10px"' + (openPwdDrawer ? ' open' : '') + '>'
        + '  <summary>🔑 修改我的登录密码（修改后自动踢下线其他设备）</summary>'
        + '  <div class="adv-body" style="display:grid;gap:8px">'
        + '    <div style="display:flex;gap:6px;align-items:center">'
        + '      <input id="inpOldPwd" type="password" placeholder="当前原密码" style="flex:1;min-width:0;min-height:34px;padding:4px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink)">'
        + '      <button type="button" class="pill" data-toggle-pwd="inpOldPwd" style="min-height:34px;padding:3px 9px;font-size:12px;white-space:nowrap">👁️ 显示</button>'
        + '    </div>'
        + '    <div style="display:flex;gap:6px;align-items:center">'
        + '      <input id="inpNewPwd" type="password" placeholder="新密码（8 位以上，须含字母与数字）" style="flex:1;min-width:0;min-height:34px;padding:4px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink)">'
        + '      <button type="button" class="pill" data-toggle-pwd="inpNewPwd" style="min-height:34px;padding:3px 9px;font-size:12px;white-space:nowrap">👁️ 显示</button>'
        + '    </div>'
        + '    <button type="button" class="pill primary" id="btnDoChangePwd">确认修改密码</button>'
        + '  </div>'
        + '</details>'
        + '<div style="margin-top:12px">'
        + '  <div style="font-size:12.5px;font-weight:800;color:var(--brown);margin-bottom:6px">📱 我当前在线的设备会话（可随时逐台踢下线）：</div>'
        + '  <div id="ownSessionsList" class="fb-log-list"><div class="src-ok">加载中…</div></div>'
        + '</div>';

      wirePwdToggleButtons(body);

      document.getElementById("btnOpenMigrateFromAuth").addEventListener("click", function () {
        document.getElementById("cloudAuthModal").hidden = true;
        openMigrateModal();
      });
      var btnAdm = document.getElementById("btnOpenAdminFromAuth");
      if (btnAdm) {
        btnAdm.addEventListener("click", function () {
          document.getElementById("cloudAuthModal").hidden = true;
          openAdminModal();
        });
      }
      document.getElementById("btnAuthLogout").addEventListener("click", function () {
        global.FG_CLOUD.logout().then(function () {
          toast("已安全退出并清除本机私有缓存与会话令牌");
          document.getElementById("cloudAuthModal").hidden = true;
        });
      });
      document.getElementById("btnDoChangePwd").addEventListener("click", function () {
        var o = document.getElementById("inpOldPwd").value;
        var n = document.getElementById("inpNewPwd").value;
        global.FG_CLOUD.changePassword(o, n).then(function (r) {
          if (!r.ok) { toast((r.data && r.data.error) || "修改失败"); return; }
          toast("✅ 密码已修改，其他旧设备会话已自动吊销");
          document.getElementById("inpOldPwd").value = "";
          document.getElementById("inpNewPwd").value = "";
          renderAuthModalBody();
        });
      });
      loadOwnSessionsUi();
      return;
    }

    // Case C: Guest / Not logged in -> Team Member Login Form (Plan A)
    var showTotp = Boolean(extraState && extraState.requireTotp);
    var preLoginId = (extraState && extraState.loginId) || "";
    body.innerHTML =
      '<p class="flag-note" style="margin:0 0 10px">外部访客无需登录即可免费使用公开 146+ 国市场数据与本地工具（数据仅存访客自己浏览器）。团队成员请用管理员统一开通的<b>独立成员账号与密码</b>登录以接入团队云端公海库。</p>'
      + '<form id="cloudLoginForm" style="display:grid;gap:8px">'
      + '  <div><label for="inpCloudLoginId" style="display:block;font-size:12px;font-weight:700;color:var(--muted);margin-bottom:3px">成员登录名（管理员统一开通，不开放自注册）</label>'
      + '    <input id="inpCloudLoginId" type="text" autocomplete="username" value="' + esc(preLoginId) + '" placeholder="例如：boss / zhangsan" style="width:100%;min-height:36px;padding:5px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink)"></div>'
      + '  <div><label for="inpCloudPwd" style="display:block;font-size:12px;font-weight:700;color:var(--muted);margin-bottom:3px">登录密码</label>'
      + '    <div style="display:flex;gap:6px;align-items:center">'
      + '      <input id="inpCloudPwd" type="password" autocomplete="current-password" placeholder="输入个人专属密码" style="flex:1;min-width:0;min-height:36px;padding:5px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink)">'
      + '      <button type="button" class="pill" data-toggle-pwd="inpCloudPwd" style="min-height:36px;padding:4px 10px;font-size:12px;white-space:nowrap">👁️ 显示</button>'
      + '    </div></div>'
      + '  <div id="cloudLoginTotpWrap"' + (showTotp ? '' : ' hidden') + '>'
      + '    <label for="inpCloudTotp" style="display:block;font-size:12px;font-weight:800;color:var(--brown);margin-bottom:3px">总负责人 2FA 动态验证码（6 位数字或一次性恢复码）</label>'
      + '    <input id="inpCloudTotp" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="输入手机验证器 6 位动态码" style="width:100%;min-height:36px;padding:5px 10px;border:1px solid var(--orange);border-radius:8px;background:var(--surface);color:var(--ink)">'
      + '  </div>'
      + '  <div id="cloudLoginErr" style="font-size:12px;color:var(--danger);font-weight:700"></div>'
      + '  <div class="pills" style="margin-top:4px">'
      + '    <button type="submit" class="pill primary" id="btnCloudDoLogin">🔓 登录 FriesGo 团队工作台</button>'
      + '  </div>'
      + '</form>';

    wirePwdToggleButtons(body);

    var form = document.getElementById("cloudLoginForm");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var lid = document.getElementById("inpCloudLoginId").value.trim();
      var pwd = document.getElementById("inpCloudPwd").value;
      var totp = document.getElementById("inpCloudTotp").value.trim();
      var errEl = document.getElementById("cloudLoginErr");
      var btn = document.getElementById("btnCloudDoLogin");
      errEl.textContent = "";
      btn.disabled = true;
      global.FG_CLOUD.login(lid, pwd, totp).then(function (r) {
        btn.disabled = false;
        if (r.ok && r.data && r.data.requireTotp) {
          document.getElementById("cloudLoginTotpWrap").hidden = false;
          errEl.textContent = r.data.message || "请输入 6 位 2FA 动态验证码";
          document.getElementById("inpCloudTotp").focus();
          return;
        }
        if (!r.ok) {
          if (r.data && r.data.requireTotp) document.getElementById("cloudLoginTotpWrap").hidden = false;
          errEl.textContent = (r.data && r.data.error) || "登录失败，请检查账号密码";
          return;
        }
        if (r.data && r.data.requireTotpSetup) {
          toast("请先完成总负责人 2FA 绑定");
          renderAuthModalBody();
          return;
        }
        var empName = (r.data.employee && r.data.employee.display_name) || "";
        if (r.data.employee && r.data.employee.must_reset_pwd) {
          toast("✅ 欢迎回来，" + empName + "！建议方便时点击右上角修改初始密码（不阻断业务）");
        } else {
          toast("✅ 欢迎回来，" + empName + "！已接入团队云端公海库");
        }
        document.getElementById("cloudAuthModal").hidden = true;
        global.FG_CLOUD.flushPendingQueue().then(function () {
          loadCloudActiveTab();
          loadCloudFeedbackBoard();
          fetchCloudCompaniesForBinding(true);
        });
      });
    });
  }

  function loadOwnSessionsUi() {
    var box = document.getElementById("ownSessionsList");
    if (!box) return;
    global.FG_CLOUD.listOwnSessions().then(function (r) {
      if (!r.ok) { box.innerHTML = '<div class="src-ok">无法加载设备列表</div>'; return; }
      var curSid = r.data.currentSessionId;
      var list = r.data.sessions || [];
      box.innerHTML = list.map(function (s) {
        var isCur = s.session_id === curSid;
        return '<div class="fb-log-item" style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">'
          + '<div><b>' + esc(s.device_label || "Web") + '</b>' + (isCur ? ' <span class="mx-ok">当前设备</span>' : '')
          + '<div class="src-ok" style="white-space:normal">最近活跃：' + esc(fmtBjt(s.last_seen_at)) + '</div></div>'
          + (isCur ? '' : '<button type="button" class="pill danger" data-kick-own-sid="' + esc(s.session_id) + '" style="min-height:26px;padding:2px 8px;font-size:11.5px">踢下线</button>')
          + '</div>';
      }).join("") || '<div class="src-ok">暂无活跃会话</div>';
      box.querySelectorAll("[data-kick-own-sid]").forEach(function (b) {
        b.addEventListener("click", function () {
          global.FG_CLOUD.revokeOwnSession(b.getAttribute("data-kick-own-sid")).then(function (res) {
            if (res.ok) { toast("已踢下线该设备"); loadOwnSessionsUi(); }
          });
        });
      });
    });
  }

  // ===== 2. Global Company Pool / My Follow-ups / Team Activity / OSM Isolated Pool =====
  function loadCloudActiveTab() {
    var st = global.FG_CLOUD.getState();
    if (!st.loggedIn || st.requireTotpSetup) return;
    syncCrmModeVisibility();
    var mode = uiState.crmMode;
    if (mode === "local") return;
    var body = document.getElementById("cloudPoolListBody");
    if (!body) return;
    body.innerHTML = '<div style="padding:18px;text-align:center;color:var(--muted)">🔄 正在从公司云端 D1 加载…</div>';

    if (mode === "team") {
      global.FG_CLOUD.listRecentEvents(false).then(function (r) {
        if (!r.ok) {
          body.innerHTML = '<div class="v2-guard-bar lv-red">加载失败：' + esc((r.data && r.data.error) || "网络异常") + '</div>';
          return;
        }
        var evs = r.data.events || [];
        if (!evs.length) {
          body.innerHTML = '<div style="padding:18px;text-align:center;color:var(--muted)">暂无团队跟进记录，点开任意公海企业点击「⚡ 开始联系」后即可自动沉淀。</div>';
          return;
        }
        body.innerHTML = '<div class="fb-log-list" style="max-height:none">' + evs.map(function (ev) {
          var stInfo = STATUS_LABELS[ev.derived_contact_status] || STATUS_LABELS.uncontacted;
          return '<div class="fb-log-item">'
            + '<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">'
            + '  <div><b>' + esc(ev.canonical_name) + '</b> <span class="meta-pill" style="padding:1px 6px;font-size:11px">' + esc(ev.country_en) + '</span> <span class="' + stInfo.cls + '" style="font-size:11px">' + esc(stInfo.txt) + '</span></div>'
            + '  <span class="src-ok">' + esc(fmtBjt(ev.occurred_at)) + '</span>'
            + '</div>'
            + '<div style="margin-top:4px">👤 <b>' + esc(ev.employee_name) + '</b> · [' + esc(ev.channel) + ' / ' + esc(ev.action_outcome) + '] ' + esc(ev.summary || "（无备注）") + '</div>'
            + '<div style="margin-top:6px"><button type="button" class="pill" data-open-cloud-comp="' + esc(ev.company_id) + '" style="min-height:26px;padding:2px 8px;font-size:11.5px">📂 查看企业档案</button></div>'
            + '</div>';
        }).join("") + '</div>';
        bindPoolListActions(body);
      });
      return;
    }

    if (mode === "osm") {
      var ctry = (document.getElementById("cloudPoolCountry") || {}).value || "ALL";
      global.FG_CLOUD.listOsmPool(ctry).then(function (r) {
        if (!r.ok) {
          body.innerHTML = '<div class="v2-guard-bar lv-red">加载 OSM 待核实池失败：' + esc((r.data && r.data.error) || "网络异常") + '</div>';
          return;
        }
        var rows = r.data.items || [];
        if (!rows.length) {
          body.innerHTML = '<div style="padding:18px;text-align:center;color:var(--muted)">OSM 待核实线索池暂无记录（与公司正式企业主档物理隔离，遵守 ODbL 许可）。在「找客户 → 地图找客户」用 OSM 搜索后点「📥 沉淀至 OSM 待核实线索池」即可自动去重入池。</div>';
          return;
        }
        body.innerHTML = '<div class="flag-note" style="margin:0 0 8px">⚖️ 物理隔离表 <code>raw_osm_pool</code>（© OpenStreetMap contributors · ODbL 1.0）：人工核实有效后点击「核实转入正式公海」进入统一企业主库。</div>'
          + '<div class="fb-log-list" style="max-height:none">' + rows.map(function (it) {
            return '<div class="fb-log-item" style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">'
              + '<div><b>' + esc(it.name) + '</b> <span class="meta-pill" style="padding:1px 6px;font-size:11px">' + esc(it.country_en) + (it.city ? (" · " + esc(it.city)) : "") + '</span>'
              + '<div class="src-ok">' + esc(it.category || "OSM") + ' · 采集于 ' + esc(fmtBjt(it.collected_at, { dateOnly: true })) + '</div></div>'
              + '<button type="button" class="pill primary" data-promote-osm="' + esc(it.id) + '" style="min-height:28px;padding:3px 10px;font-size:12px">✓ 核实转入正式公海</button>'
              + '</div>';
          }).join("") + '</div>';
        body.querySelectorAll("[data-promote-osm]").forEach(function (b) {
          b.addEventListener("click", function () {
            var oid = b.getAttribute("data-promote-osm");
            global.FG_CLOUD.promoteOsmLead(oid, {}).then(function (res) {
              if (!res.ok) { toast((res.data && res.data.error) || "转入失败"); return; }
              toast("✅ 已核实转入正式公海主库！");
              loadCloudActiveTab();
              fetchCloudCompaniesForBinding(true);
            });
          });
        });
      });
      return;
    }

    // pool | mine
    var params = {
      view: mode === "mine" ? "mine" : "pool",
      country: (document.getElementById("cloudPoolCountry") || {}).value || "ALL",
      pool_stage: (document.getElementById("cloudPoolStage") || {}).value || "all",
      contact_status: (document.getElementById("cloudPoolStatus") || {}).value || "all",
      q: ((document.getElementById("cloudPoolSearch") || {}).value || "").trim(),
      limit: uiState.pageLimit,
      offset: uiState.pageOffset,
    };
    global.FG_CLOUD.listCompanies(params).then(function (r) {
      if (!r.ok) {
        body.innerHTML = '<div class="v2-guard-bar lv-red">拉取公海库失败：' + esc((r.data && r.data.error) || "请检查网络或重新登录") + '</div>';
        return;
      }
      uiState.total = Number(r.data.total || 0);
      uiState.items = r.data.items || [];
      if (mode === "pool" && params.country === "ALL" && params.pool_stage === "all" && params.contact_status === "all" && !params.q && params.offset === 0) {
        uiState.bindingCache = uiState.items;
        uiState.bindingTotal = uiState.total;
        uiState.bindingLoadedAt = Date.now();
        notifyCrossModuleRefresh();
      }
      renderCloudCompanyList();
    });
  }

  function renderCloudCompanyList() {
    var body = document.getElementById("cloudPoolListBody");
    var pager = document.getElementById("cloudPoolPager");
    if (!body) return;
    if (!uiState.items.length) {
      body.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted)">当前筛选条件下公海库暂无企业记录。可点击「＋ 新增公海企业」或「📤 6 步迁入本机历史客户」。</div>';
      if (pager) pager.innerHTML = "";
      return;
    }
    body.innerHTML = '<div style="display:grid;gap:8px">' + uiState.items.map(function (c) {
      var stInfo = STATUS_LABELS[c.derived_contact_status] || STATUS_LABELS.uncontacted;
      var poolLbl = POOL_STAGE_LABELS[c.pool_stage] || c.pool_stage;
      var compLbl = COMP_STATUS_LABELS[c.compliance_status] || c.compliance_status;
      var isBlocked = c.derived_contact_status === "stopped" || c.opt_out_status !== "none" || c.compliance_status === "blocked";
      var lastEv = c.last_event_summary && c.last_event_summary.employee_name
        ? ('最近动态：<b>' + esc(c.last_event_summary.employee_name) + '</b> · ' + esc(c.last_event_summary.channel || "") + ' · ' + esc(c.last_event_summary.action_outcome || "") + '（' + esc(fmtBjt(c.last_event_summary.occurred_at, { dateOnly: true })) + '）' + (c.last_event_summary.summary ? (' — ' + esc(c.last_event_summary.summary.slice(0, 48))) : ''))
        : '尚无团队联系记录（可优先跟进）';
      var lockLine = c.active_lock
        ? '<div style="font-size:12px;color:var(--med);font-weight:800;margin-top:3px">🔒 同事 ' + esc(c.active_lock.employee_name) + ' 正在通过 ' + esc(c.active_lock.channel) + ' 处理本次联系（锁至 ' + esc(fmtBjt(c.active_lock.expires_at, { timeOnly: true })) + '）</div>'
        : '';
      return '<div class="ms-card" style="box-shadow:none">'
        + '<div class="ms-card-head">'
        + '  <div class="ms-card-title">' + esc(c.canonical_name) + ' <span class="meta-pill" style="padding:1px 7px;font-size:11px">' + esc(c.country_en) + (c.city ? (' · ' + esc(c.city)) : '') + '</span> <span class="meta-pill" style="padding:1px 7px;font-size:11px">' + esc(poolLbl) + '</span></div>'
        + '  <span class="' + stInfo.cls + '" style="font-size:11.5px">' + esc(stInfo.txt) + '</span>'
        + '</div>'
        + '<div class="ms-card-meta">'
        + '  <div>' + (c.website_domain ? ('🌐 ' + esc(c.website_domain) + ' ｜ ') : '') + (c.product_summary ? ('📦 ' + esc(c.product_summary) + ' ｜ ') : '') + '合规：' + esc(compLbl) + ' ｜ 版本 v' + esc(c.version) + '</div>'
        + '  <div>' + lastEv + '</div>'
        + lockLine
        + '</div>'
        + '<div class="pills" style="margin-top:8px">'
        + (isBlocked
            ? '<button type="button" class="pill danger" disabled style="min-height:30px;padding:3px 10px;font-size:12px;opacity:.75">⛔ 已禁发/退订（硬阻断）</button>'
            : '<button type="button" class="pill primary" data-cloud-lock="' + esc(c.id) + '" data-cloud-cname="' + esc(c.canonical_name) + '" style="min-height:30px;padding:3px 10px;font-size:12px">⚡ 开始联系（防重锁）</button>')
        + '  <button type="button" class="pill" data-open-cloud-comp="' + esc(c.id) + '" style="min-height:30px;padding:3px 10px;font-size:12px">📂 详情与团队时间线</button>'
        + '</div>'
        + '</div>';
    }).join("") + '</div>';

    bindPoolListActions(body);

    if (pager) {
      var start = uiState.pageOffset + 1;
      var end = Math.min(uiState.total, uiState.pageOffset + uiState.items.length);
      pager.innerHTML =
        '<span class="src-ok">显示第 ' + start + '–' + end + ' 家 / 共 ' + uiState.total + ' 家公海企业（按索引分页拉取，不缓存全库）</span>'
        + '<div class="pills" style="margin:0">'
        + '<button type="button" class="pill" id="btnPoolPrev" ' + (uiState.pageOffset <= 0 ? 'disabled' : '') + ' style="min-height:28px;padding:2px 10px;font-size:12px">上一页</button>'
        + '<button type="button" class="pill" id="btnPoolNext" ' + (end >= uiState.total ? 'disabled' : '') + ' style="min-height:28px;padding:2px 10px;font-size:12px">下一页</button>'
        + '</div>';
      var pPrev = document.getElementById("btnPoolPrev");
      var pNext = document.getElementById("btnPoolNext");
      if (pPrev) pPrev.addEventListener("click", function () { uiState.pageOffset = Math.max(0, uiState.pageOffset - uiState.pageLimit); loadCloudActiveTab(); });
      if (pNext) pNext.addEventListener("click", function () { uiState.pageOffset += uiState.pageLimit; loadCloudActiveTab(); });
    }
  }

  function bindPoolListActions(container) {
    container.querySelectorAll("[data-cloud-lock]").forEach(function (b) {
      b.addEventListener("click", function () {
        startContactWithLock(b.getAttribute("data-cloud-lock"), b.getAttribute("data-cloud-cname"));
      });
    });
    container.querySelectorAll("[data-open-cloud-comp]").forEach(function (b) {
      b.addEventListener("click", function () {
        openCloudCompanyDetail(b.getAttribute("data-open-cloud-comp"));
      });
    });
  }

  // S05 + D09: Full Cloud Company Detail (edit, add contact, workflow jumps, quotes, compliance logs, merge/unmerge)
  function openCloudCompanyDetail(companyId) {
    var box = document.getElementById("cloudPoolDetailBox");
    if (!box) return;
    box.hidden = false;
    box.innerHTML = '<div style="padding:14px;color:var(--muted)">🔄 正在加载企业详情与团队联系历史…</div>';
    global.FG_CLOUD.getCompany(companyId).then(function (r) {
      if (!r.ok) {
        box.innerHTML = '<div class="v2-guard-bar lv-red">加载失败：' + esc((r.data && r.data.error) || "错误") + '</div>';
        return;
      }
      uiState.selectedCompanyId = companyId;
      uiState.selectedDetail = r.data;
      var st = global.FG_CLOUD.getState();
      var isMgrOrSuper = st.employee && (st.employee.role === "super_admin" || st.employee.role === "manager");
      var isSuper = st.employee && st.employee.role === "super_admin";
      var c = r.data.company;
      var contacts = r.data.contacts || [];
      var events = r.data.events || [];
      var quotes = r.data.quotes || [];
      var compLogs = r.data.complianceLogs || [];
      var sources = r.data.sources || [];
      var stInfo = STATUS_LABELS[c.derived_contact_status] || STATUS_LABELS.uncontacted;
      var compLbl = COMP_STATUS_LABELS[c.compliance_status] || c.compliance_status;
      var isBlocked = c.opt_out_status !== "none" || c.compliance_status === "blocked";

      var mergeTargets = (uiState.bindingCache.length ? uiState.bindingCache : uiState.items).filter(function (x) {
        return x && x.id !== c.id;
      });

      box.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap">'
        + '  <div><h3 style="margin:0;color:var(--brown)">' + esc(c.canonical_name) + ' <span class="' + stInfo.cls + '" style="font-size:11.5px">' + esc(stInfo.txt) + '</span></h3>'
        + '  <div class="src-ok" style="margin-top:3px;white-space:normal">' + esc(c.country_en) + (c.city ? (' · ' + esc(c.city)) : '') + (c.website ? (' · 🌐 ' + esc(c.website)) : '') + ' · v' + esc(c.version) + ' · 合规：' + esc(compLbl) + ' · 退订：' + esc(c.opt_out_status) + '</div>'
        + (c.note ? ('<div class="src-ok" style="margin-top:2px;white-space:normal">📝 备注：' + esc(c.note) + '</div>') : '')
        + '  </div>'
        + '  <div class="pills" style="margin:0">'
        + (isBlocked ? '' : '<button type="button" class="pill primary" id="btnDetailAcquireLock" style="min-height:28px;padding:2px 10px;font-size:12px">⚡ 开始联系（锁客）</button>')
        + '    <button type="button" class="pill" id="btnDetailToggleEdit" style="min-height:28px;padding:2px 9px;font-size:12px">✏️ 编辑资料</button>'
        + '    <button type="button" class="pill" id="btnDetailToggleContact" style="min-height:28px;padding:2px 9px;font-size:12px">＋ 新增联系人</button>'
        + (!isBlocked ? '<button type="button" class="pill danger" id="btnDetailOptOut" style="min-height:28px;padding:2px 10px;font-size:12px">⛔ 登记拒绝/退订</button>' : '')
        + '    <button type="button" class="pill" id="btnDetailClose" style="min-height:28px;padding:2px 8px;font-size:12px">× 收起</button>'
        + '  </div>'
        + '</div>'

        // 1-Click Cross-Module Workflow Bar (D09 + S05)
        + '<div class="pills" style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--line)">'
        + '  <span class="src-ok" style="font-weight:800">一键衔接作业：</span>'
        + '  <button type="button" class="pill" id="btnDetailJumpEmail" style="min-height:26px;padding:2px 9px;font-size:11.5px">✉️ 写开发信</button>'
        + '  <button type="button" class="pill" id="btnDetailJumpQuote" style="min-height:26px;padding:2px 9px;font-size:11.5px">🧮 去做报价</button>'
        + '  <button type="button" class="pill" id="btnDetailJumpDd" style="min-height:26px;padding:2px 9px;font-size:11.5px">🛡️ 去做背调</button>'
        + '  <button type="button" class="pill" id="btnDetailJumpPrecheck" style="min-height:26px;padding:2px 9px;font-size:11.5px">📦 逐单合规</button>'
        + (isMgrOrSuper ? '<button type="button" class="pill" id="btnDetailToggleMerge" style="min-height:26px;padding:2px 9px;font-size:11.5px">🔀 合并重复</button>' : '')
        + (isSuper && uiState.lastMergeAuditId ? '<button type="button" class="pill" id="btnDetailUndoMerge" style="min-height:26px;padding:2px 9px;font-size:11.5px">↩️ 撤销上次合并</button>' : '')
        + '</div>'

        // Inline Edit Company Form (optimistic locking with expected_version)
        + '<div id="detailEditWrap" hidden style="margin-top:10px;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--surface2);display:grid;gap:8px">'
        + '  <div style="font-size:12.5px;font-weight:800;color:var(--brown)">✏️ 编辑企业主档（含乐观锁 version=' + esc(c.version) + ' 并发保护）</div>'
        + '  <div class="form-grid-3" style="gap:8px">'
        + '    <input id="edCompName" type="text" value="' + esc(c.canonical_name) + '" placeholder="企业名称" style="min-height:32px;padding:3px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink)">'
        + '    <input id="edCompCity" type="text" value="' + esc(c.city || "") + '" placeholder="城市" style="min-height:32px;padding:3px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink)">'
        + '    <input id="edCompWeb" type="text" value="' + esc(c.website || "") + '" placeholder="官网 URL" style="min-height:32px;padding:3px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink)">'
        + '  </div>'
        + '  <div class="form-grid-3" style="gap:8px">'
        + '    <input id="edCompProd" type="text" value="' + esc(c.product_summary || "") + '" placeholder="主营/意向设备" style="min-height:32px;padding:3px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink)">'
        + '    <select id="edCompPoolStage" style="min-height:32px;padding:3px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink)">'
        + '      <option value="raw_pending"' + (c.pool_stage === "raw_pending" ? " selected" : "") + '>待核实线索</option>'
        + '      <option value="verified_pool"' + (c.pool_stage === "verified_pool" ? " selected" : "") + '>有效公海</option>'
        + '      <option value="active"' + (c.pool_stage === "active" ? " selected" : "") + '>跟进中</option>'
        + '    </select>'
        + '    <select id="edCompCompliance" style="min-height:32px;padding:3px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink)">'
        + '      <option value="unchecked"' + (c.compliance_status === "unchecked" ? " selected" : "") + '>未背调 (unchecked)</option>'
        + '      <option value="review"' + (c.compliance_status === "review" ? " selected" : "") + '>复核中 (review)</option>'
        + '      <option value="approved"' + (c.compliance_status === "approved" ? " selected" : "") + '>✅ 审批通过 (approved)</option>'
        + '      <option value="blocked"' + (c.compliance_status === "blocked" ? " selected" : "") + '>⛔ 合规阻断 (blocked)</option>'
        + '    </select>'
        + '  </div>'
        + '  <input id="edCompNote" type="text" value="' + esc(c.note || "") + '" placeholder="备注（采购需求/付款习惯等）" style="width:100%;min-height:32px;padding:3px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink)">'
        + '  <div class="pills" style="margin:0"><button type="button" class="pill primary" id="btnDetailSaveEdit">💾 保存修改</button></div>'
        + '</div>'

        // Inline Add Contact Form
        + '<div id="detailAddContactWrap" hidden style="margin-top:10px;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--surface2);display:grid;gap:8px">'
        + '  <div style="font-size:12.5px;font-weight:800;color:var(--brown)">＋ 为「' + esc(c.canonical_name) + '」新增联系人</div>'
        + '  <div class="form-grid-4" style="gap:6px">'
        + '    <input id="edCtName" type="text" placeholder="姓名（如 John）" style="min-height:32px;padding:3px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink)">'
        + '    <input id="edCtRole" type="text" placeholder="职位（如 Procurement）" style="min-height:32px;padding:3px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink)">'
        + '    <input id="edCtEmail" type="email" placeholder="邮箱（sales@corp.com）" style="min-height:32px;padding:3px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink)">'
        + '    <input id="edCtPhone" type="text" placeholder="电话/WhatsApp（含国码）" style="min-height:32px;padding:3px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink)">'
        + '  </div>'
        + '  <div class="pills" style="margin:0"><button type="button" class="pill primary" id="btnDetailSaveContact">✅ 保存联系人</button></div>'
        + '</div>'

        // Inline Merge Panel (Manager / Super Admin)
        + (isMgrOrSuper
            ? ('<div id="detailMergeWrap" hidden style="margin-top:10px;padding:10px;border:1px dashed var(--orange);border-radius:10px;background:var(--surface2);display:grid;gap:8px">'
                + '  <div style="font-size:12px;font-weight:800;color:var(--brown)">🔀 将当前企业合并到已有主档（所有联系人、时间线、报价与退订状态自动无损转移，总负责人可撤销）：</div>'
                + '  <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">'
                + '    <select id="selMergeTarget" style="flex:1;min-width:180px;max-width:100%;min-height:32px;padding:3px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink)">'
                + '      <option value="">请选择合并目标主档企业…</option>'
                + mergeTargets.map(function (t) { return '<option value="' + esc(t.id) + '">' + esc(t.canonical_name) + ' (' + esc(t.country_en) + ')</option>'; }).join("")
                + '    </select>'
                + '    <button type="button" class="pill danger" id="btnDetailDoMerge" style="min-height:32px;padding:3px 12px;font-size:12px">确认合并</button>'
                + '  </div>'
                + '</div>')
            : '')

        + '<div style="margin-top:10px;display:grid;gap:10px">'
        + '  <div><b>👥 企业联系人（' + contacts.length + '）：</b>'
        + (contacts.length
            ? contacts.map(function (ct) { return '<div class="src-ok" style="white-space:normal">• ' + esc(ct.name || "未填姓名") + (ct.role ? (' (' + esc(ct.role) + ')') : '') + (ct.email ? (' · ' + esc(ct.email) + ' [' + esc(ct.email_verify_level) + ']') : '') + (ct.phone_e164 ? (' · +' + esc(ct.phone_e164)) : '') + '</div>'; }).join("")
            : '<span class="src-ok">暂无联系人（点上方「＋ 新增联系人」补充）</span>')
        + '  </div>'
        + '  <div><b>📜 团队联系与业务事件时间线（不可覆盖，共 ' + events.length + ' 条）：</b>'
        + '    <div class="fb-log-list">'
        + (events.length
            ? events.map(function (ev) {
                return '<div class="fb-log-item"><b>' + esc(ev.employee_name) + '</b> · [' + esc(ev.channel) + ' / ' + esc(ev.action_outcome) + '] · ' + esc(fmtBjt(ev.occurred_at)) + '<br>' + esc(ev.summary || "（无备注）") + '</div>';
              }).join("")
            : '<div class="src-ok">暂无联系记录</div>')
        + '    </div>'
        + '  </div>'
        + '  <div><b>🧮 云端报价版本记录（共 ' + quotes.length + ' 条，跨成员共享）：</b>'
        + (quotes.length
            ? '<div class="fb-log-list">' + quotes.map(function (q) {
                var p = {};
                try { p = typeof q.payload_json === "string" ? JSON.parse(q.payload_json) : (q.payload || {}); } catch (_) {}
                var tierLbl = q.quote_tier === "formal" ? "✅ 正式报价 (Formal)" : "📋 估算参考 (Indicative)";
                var amt = p.cifTotal ? ("CIF \$" + p.cifTotal) : (p.fobTotal ? ("FOB \$" + p.fobTotal) : (p.summary || ""));
                return '<div class="fb-log-item"><b>' + esc(q.ref_no || q.quote_id) + '</b> · ' + esc(tierLbl) + (amt ? (' · ' + esc(amt)) : '') + (q.sent_confirmed ? ' · <span class="mx-ok">已发客户</span>' : '')
                  + '<div class="src-ok">' + esc(fmtBjt(q.created_at)) + (p.note ? (' · ' + esc(p.note)) : '') + '</div></div>';
              }).join("") + '</div>'
            : '<div class="src-ok">暂无云端报价记录（点击上方「🧮 去做报价」可直接关联此企业并存档）</div>')
        + '  </div>'
        + '  <div><b>📦 逐单合规自查台账（共 ' + compLogs.length + ' 条，跨成员共享）：</b>'
        + (compLogs.length
            ? '<div class="fb-log-list">' + compLogs.map(function (cl) {
                return '<div class="fb-log-item"><b>单号 ' + esc(cl.order_ref || cl.log_id) + '</b> · 结论：<b>' + esc(cl.decision) + '</b> · 复核人：' + esc(cl.reviewer || "成员")
                  + '<div class="src-ok">' + esc(fmtBjt(cl.saved_at || cl.created_at)) + '</div></div>';
              }).join("") + '</div>'
            : '<div class="src-ok">暂无逐单合规台账（点击上方「📦 逐单合规」可直接存档）</div>')
        + '  </div>'
        + '  <div class="src-ok" style="white-space:normal"><b>独立来源记录：</b>' + (sources.length ? sources.map(function (s) { return esc(s.source_type + "(" + s.license_class + ")"); }).join("、") : "手工建档") + '</div>'
        + '</div>';

      document.getElementById("btnDetailClose").addEventListener("click", function () { box.hidden = true; });
      var bLock = document.getElementById("btnDetailAcquireLock");
      if (bLock) bLock.addEventListener("click", function () { startContactWithLock(c.id, c.canonical_name); });

      var bEdit = document.getElementById("btnDetailToggleEdit");
      var edWrap = document.getElementById("detailEditWrap");
      if (bEdit && edWrap) bEdit.addEventListener("click", function () { edWrap.hidden = !edWrap.hidden; });

      var bSaveEdit = document.getElementById("btnDetailSaveEdit");
      if (bSaveEdit) {
        bSaveEdit.addEventListener("click", function () {
          global.FG_CLOUD.updateCompany(c.id, {
            expected_version: c.version,
            canonical_name: document.getElementById("edCompName").value.trim(),
            city: document.getElementById("edCompCity").value.trim(),
            website: document.getElementById("edCompWeb").value.trim(),
            product_summary: document.getElementById("edCompProd").value.trim(),
            pool_stage: document.getElementById("edCompPoolStage").value,
            compliance_status: document.getElementById("edCompCompliance").value,
            note: document.getElementById("edCompNote").value.trim(),
          }).then(function (res) {
            if (!res.ok) {
              toast((res.data && res.data.error) || "保存失败（可能已被其他同事更新，请刷新）");
              return;
            }
            toast("✅ 企业资料已更新并全员同步！");
            openCloudCompanyDetail(c.id);
            loadCloudActiveTab();
            fetchCloudCompaniesForBinding(true);
          });
        });
      }

      var bCt = document.getElementById("btnDetailToggleContact");
      var ctWrap = document.getElementById("detailAddContactWrap");
      if (bCt && ctWrap) bCt.addEventListener("click", function () { ctWrap.hidden = !ctWrap.hidden; });

      var bSaveCt = document.getElementById("btnDetailSaveContact");
      if (bSaveCt) {
        bSaveCt.addEventListener("click", function () {
          global.FG_CLOUD.addCompanyContact(c.id, {
            name: document.getElementById("edCtName").value.trim(),
            role: document.getElementById("edCtRole").value.trim(),
            email: document.getElementById("edCtEmail").value.trim(),
            phone: document.getElementById("edCtPhone").value.trim(),
          }).then(function (res) {
            if (!res.ok) { toast((res.data && res.data.error) || "新增联系人失败"); return; }
            toast("✅ 已新增联系人并同步至团队公海");
            openCloudCompanyDetail(c.id);
          });
        });
      }

      // 1-click workflow jumps (D09 + S05)
      [
        ["btnDetailJumpEmail", "email-gen"],
        ["btnDetailJumpQuote", "quote-calc"],
        ["btnDetailJumpDd", "due-diligence"],
        ["btnDetailJumpPrecheck", "precheck"],
      ].forEach(function (pair) {
        var btn = document.getElementById(pair[0]);
        if (btn) {
          btn.addEventListener("click", function () {
            if (typeof global._jumpFromCloudCompany === "function") {
              global._jumpFromCloudCompany(c, contacts, pair[1]);
            } else {
              toast("请切换到对应业务模块继续作业");
            }
          });
        }
      });

      var bMergeTog = document.getElementById("btnDetailToggleMerge");
      var mergeWrap = document.getElementById("detailMergeWrap");
      if (bMergeTog && mergeWrap) bMergeTog.addEventListener("click", function () { mergeWrap.hidden = !mergeWrap.hidden; });

      var bDoMerge = document.getElementById("btnDetailDoMerge");
      if (bDoMerge) {
        bDoMerge.addEventListener("click", function () {
          var tgtId = (document.getElementById("selMergeTarget") || {}).value || "";
          if (!tgtId) { toast("请先选择合并目标主档企业"); return; }
          global.FG_CLOUD.mergeCompanies(c.id, tgtId).then(function (res) {
            if (!res.ok) { toast((res.data && res.data.error) || "合并失败"); return; }
            uiState.lastMergeAuditId = res.data.auditId || "";
            toast("✅ 已无损合并重复企业（可随时撤销），已跳转到主档");
            loadCloudActiveTab();
            fetchCloudCompaniesForBinding(true);
            openCloudCompanyDetail(tgtId);
          });
        });
      }

      var bUndoMerge = document.getElementById("btnDetailUndoMerge");
      if (bUndoMerge) {
        bUndoMerge.addEventListener("click", function () {
          if (!uiState.lastMergeAuditId) return;
          global.FG_CLOUD.unmergeCompany(uiState.lastMergeAuditId).then(function (res) {
            if (!res.ok) { toast((res.data && res.data.error) || "撤销失败"); return; }
            uiState.lastMergeAuditId = "";
            toast("↩️ 已撤销上次合并，源企业与历史记录已完整恢复");
            loadCloudActiveTab();
            fetchCloudCompaniesForBinding(true);
            openCloudCompanyDetail(res.data.restoredSourceId || c.id);
          });
        });
      }

      var bOpt = document.getElementById("btnDetailOptOut");
      if (bOpt) {
        bOpt.addEventListener("click", function () {
          global.FG_CLOUD.recordEvent({
            company_id: c.id,
            channel: "email",
            action_outcome: "unsubscribed",
            summary: "客户明确拒绝或要求退订（团队同步硬阻断）",
          }).then(function (res) {
            if (res.ok) {
              toast("⛔ 已全团队同步退订硬阻断状态");
              openCloudCompanyDetail(c.id);
              loadCloudActiveTab();
              fetchCloudCompaniesForBinding(true);
            } else {
              toast((res.data && res.data.error) || "操作失败");
            }
          });
        });
      }
      box.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }

  // ===== 3. Atomic Contact Lock & Colleague Coordination Modal =====
  function startContactWithLock(companyId, companyName) {
    injectModalsOnce();
    var modal = document.getElementById("cloudLockModal");
    var body = document.getElementById("cloudLockBody");
    modal.hidden = false;
    body.innerHTML = '<div style="padding:14px;color:var(--muted)">🔒 正在向云端申请防撞单短时锁并核对团队联系历史…</div>';

    global.FG_CLOUD.acquireLock(companyId, "email").then(function (r) {
      if (!r.ok) {
        var lv = r.offline ? "lv-yellow" : "lv-red";
        body.innerHTML =
          '<div class="v2-guard-bar ' + lv + '"><b>' + esc((r.data && r.data.error) || "无法获取联系锁") + '</b></div>'
          + (r.data && r.data.history && r.data.history.length
              ? '<div style="margin-top:8px"><b>团队近期联系历史：</b><div class="fb-log-list">'
                + r.data.history.map(function (h) {
                    return '<div class="fb-log-item"><b>' + esc(h.employee_name) + '</b> · ' + esc(h.channel) + ' / ' + esc(h.action_outcome) + ' · ' + esc(fmtBjt(h.occurred_at)) + '<br>' + esc(h.summary || "") + '</div>';
                  }).join("")
                + '</div></div>'
              : '')
          + '<div class="pills" style="margin-top:10px"><button type="button" class="pill" id="btnLockErrOk">知道了</button></div>';
        document.getElementById("btnLockErrOk").addEventListener("click", function () { modal.hidden = true; });
        return;
      }

      var lk = r.data.lock;
      var hasCol = Boolean(r.data.hasColleagueHistory);
      var colHist = r.data.colleagueHistory || [];
      uiState.activeLockCtx = { companyId: companyId, companyName: companyName, lock: lk, hasColleagueHistory: hasCol, coordinated: !hasCol };

      var colHtml = hasCol
        ? ('<div class="v2-guard-bar lv-yellow" style="margin-bottom:10px">'
            + '<b>⚠️ 同事历史联系提醒：</b>其他成员曾联系过「' + esc(companyName) + '」，建议先看下方记录并与同事内部沟通后再确认继续：'
            + '<div class="fb-log-list" style="margin-top:6px">'
            + colHist.map(function (h) {
                return '<div class="fb-log-item"><b>' + esc(h.employee_name) + '</b> · ' + esc(h.channel) + ' / ' + esc(h.action_outcome) + ' · ' + esc(fmtBjt(h.occurred_at)) + '<br>' + esc(h.summary || "") + '</div>';
              }).join("")
            + '</div>'
            + '<label style="display:flex;align-items:center;gap:6px;margin-top:8px;font-weight:800;cursor:pointer"><input type="checkbox" id="chkColleagueCoordinated"> 我已查看历史并与同事内部协调，确认继续开发</label>'
            + '</div>')
        : '';

      body.innerHTML =
        '<div class="v2-guard-bar lv-green"><b>🔒 已为「' + esc(companyName) + '」锁定短时操作权</b>（非永久归属 · 锁标识 <code>' + esc(lk.lock_id) + '</code> · 自动释放 ' + esc(fmtBjt(lk.expires_at, { timeOnly: true })) + '）</div>'
        + colHtml
        + '<div style="display:grid;gap:8px;margin-top:8px">'
        + '  <div class="form-grid" style="grid-template-columns:1fr 1fr;gap:8px">'
        + '    <div><label style="font-size:12px;font-weight:700;color:var(--muted)">联系渠道</label>'
        + '      <select id="inpEvChannel" style="width:100%;min-height:34px;padding:4px 8px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink)">'
        + '        <option value="email">邮件 (Email)</option><option value="whatsapp">WhatsApp</option><option value="phone">电话 (Phone)</option><option value="linkedin">领英 (LinkedIn)</option><option value="quote">正式报价</option>'
        + '      </select></div>'
        + '    <div><label style="font-size:12px;font-weight:700;color:var(--muted)">真实业务结果</label>'
        + '      <select id="inpEvOutcome" style="width:100%;min-height:34px;padding:4px 8px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink)">'
        + '        <option value="sent">已发送开发信/消息</option><option value="no_answer">电话未接通</option><option value="hung_up">接通被挂断</option><option value="replied">客户有效回复</option><option value="inquiry">获得明确询盘</option><option value="quote_sent">已发正式报价单</option><option value="rejected">⛔ 客户明确拒绝</option><option value="unsubscribed">⛔ 客户要求退订（全团队禁发）</option>'
        + '      </select></div>'
        + '  </div>'
        + '  <div><label style="font-size:12px;font-weight:700;color:var(--muted)">本次真实进展摘要</label>'
        + '    <input id="inpEvSummary" type="text" placeholder="例如：已发阀门英文目录及 FOB 报价参考，约周四 WhatsApp 跟进" style="width:100%;min-height:34px;padding:4px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink)"></div>'
        + '  <div><label style="font-size:12px;font-weight:700;color:var(--muted)">下次跟进日期（选填）</label>'
        + '    <input id="inpEvNextDate" type="date" style="min-height:34px;padding:4px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink)"></div>'
        + '</div>'
        + '<div class="pills" style="margin-top:12px">'
        + '  <button type="button" class="pill primary" id="btnLockSaveEvent">✅ 确认保存真实结果并释放锁</button>'
        + '  <button type="button" class="pill" id="btnLockCancelRelease">取消本次联系并立即释放锁</button>'
        + '</div>';

      document.getElementById("btnLockSaveEvent").addEventListener("click", function () {
        var chk = document.getElementById("chkColleagueCoordinated");
        if (hasCol && chk && !chk.checked) {
          toast("请先勾选「我已查看历史并与同事内部协调」后再记录联系");
          return;
        }
        var ch = document.getElementById("inpEvChannel").value;
        var out = document.getElementById("inpEvOutcome").value;
        var sum = document.getElementById("inpEvSummary").value.trim();
        var nd = document.getElementById("inpEvNextDate").value;

        var preChain = hasCol
          ? global.FG_CLOUD.recordEvent({
              company_id: companyId,
              channel: "coordination",
              action_outcome: "coordinated",
              summary: "已核查同事历史联系记录并完成内部协调，继续开发",
            })
          : Promise.resolve({ ok: true });

        preChain.then(function () {
          return global.FG_CLOUD.recordEvent({
            company_id: companyId,
            channel: ch,
            action_outcome: out,
            summary: sum || ("通过 " + ch + " 完成触达：" + out),
            next_follow_date: nd,
            release_lock_id: lk.lock_id,
          });
        }).then(function (res) {
          if (res.ok) {
            toast("✅ 已同步真实业务记录到公司云端并释放防重锁！");
            modal.hidden = true;
            loadCloudActiveTab();
            fetchCloudCompaniesForBinding(true);
            if (uiState.selectedCompanyId === companyId) openCloudCompanyDetail(companyId);
          } else if (res.queueFull || res.storageFull) {
            toast((res.data && res.data.error) || "⚠️ 本地待同步队列已满或空间不足，无法暂存！");
          } else if (res.queuedOffline) {
            toast((res.data && res.data.message) || "🟡 当前断网，记录已暂存待同步队列（恢复联网将幂等补传）");
            modal.hidden = true;
          } else {
            toast((res.data && res.data.error) || "保存失败");
          }
        });
      });

      document.getElementById("btnLockCancelRelease").addEventListener("click", function () {
        global.FG_CLOUD.releaseLock(companyId, lk.lock_id).then(function () {
          toast("已释放短时联系锁");
          modal.hidden = true;
          loadCloudActiveTab();
        });
      });
    });
  }

  // ===== 4. 6-Step Safe Historical IndexedDB -> Cloud Migration Wizard =====
  function openMigrateModal() {
    injectModalsOnce();
    var modal = document.getElementById("cloudMigrateModal");
    modal.hidden = false;
    uiState.migBackedUp = false;
    uiState.migDryRun = null;

    var body = document.getElementById("cloudMigrateBody");
    var p = (global.FG_STORE && typeof global.FG_STORE.loadState === "function")
      ? global.FG_STORE.loadState()
      : Promise.resolve({ activeLeads: [], complianceLogs: [] });

    p.then(function (st) {
      var rawLeads = (st && Array.isArray(st.activeLeads)) ? st.activeLeads : [];
      var leads = rawLeads.filter(function (x) { return x && !x.deletedAt; });
      var compLogs = (st && Array.isArray(st.complianceLogs)) ? st.complianceLogs : [];
      uiState.migLocalData = { leads: leads, complianceLogs: compLogs };
      body.innerHTML =
        '<div class="v2-guard-bar lv-yellow"><b>🛡️ 6 步安全无损迁移原则：</b>严禁自动清空本机库！必须先导出一份带时间戳的本地 JSON 快照备份 → 在线查重预演 → 人工确认疑似重复项 → 携带稳定 ID 幂等导入 → 核对迁移前后数量报告 → 抽检重点客户。</div>'
        + '<div class="fb-log-item" style="margin-bottom:10px">当前本机 IndexedDB 扫描到：<b>' + leads.length + '</b> 家活跃客户档案 ｜ <b>' + compLogs.length + '</b> 条逐单合规台账。</div>'
        + '<div class="pills">'
        + '  <button type="button" class="pill primary" id="btnMigStep1Backup">第 1 步：强制导出本机原始快照备份</button>'
        + '  <button type="button" class="pill" id="btnMigStep2DryRun" disabled>第 2 步：在线查重预演（不写库）</button>'
        + '</div>'
        + '<div id="migPreviewArea" style="margin-top:10px"></div>';

      document.getElementById("btnMigStep1Backup").addEventListener("click", function () {
        var snap = {
          exportedAt: new Date().toISOString(),
          source: "FriesGo Local IndexedDB Pre-Migration Backup",
          crmLeads: leads,
          complianceLogs: compLogs,
        };
        var fname = "friesgo-local-pre-migration-backup-" + fmtBjt(new Date().toISOString(), { dateOnly: true }) + ".json";
        if (typeof global.downloadFile === "function") {
          global.downloadFile(fname, JSON.stringify(snap, null, 2), "application/json;charset=utf-8");
        }
        uiState.migBackedUp = true;
        document.getElementById("btnMigStep2DryRun").disabled = false;
        toast("✅ 已导出本机原始快照备份，现在可执行第 2 步查重预演");
      });

      document.getElementById("btnMigStep2DryRun").addEventListener("click", function () {
        var prev = document.getElementById("migPreviewArea");
        prev.innerHTML = '<div class="src-ok">🔄 正在执行云端 Dry-Run 查重预演…</div>';
        global.FG_CLOUD.migrateDryRun(leads, compLogs).then(function (r) {
          if (!r.ok) {
            prev.innerHTML = '<div class="v2-guard-bar lv-red">预演失败：' + esc((r.data && r.data.error) || "错误") + '</div>';
            return;
          }
          uiState.migDryRun = r.data;
          var s = r.data.summary;
          var suspects = (r.data.preview || []).filter(function (x) { return x.action === "suspect_review"; });
          prev.innerHTML =
            '<div class="v2-guard-bar lv-green">'
            + '<b>第 2–3 步预演结果（零写入）：</b>将新建 <b>' + s.createCount + '</b> 家 ｜ 高置信合并 <b>' + s.mergeHighCount + '</b> 家 ｜ 疑似重复待人工确认 <b>' + s.suspectReviewCount + '</b> 家 ｜ 时间线 ' + s.timelineTotal + ' 条 ｜ 报价 ' + s.quoteTotal + ' 条 ｜ 合规台账 ' + s.complianceLogTotal + ' 条'
            + (s.gmapsLegacyFlagged ? ('<div style="color:var(--med);margin-top:4px">⚠️ 检测到 ' + s.gmapsLegacyFlagged + ' 条历史旧记录来源标注含 Google Maps，请核实独立官网来源后再保留！</div>') : '')
            + '</div>'
            + (suspects.length
                ? '<div style="margin:8px 0"><b>第 3 步：请逐条确认疑似重复项（绝不盲目合并集团/分支）：</b><div class="fb-log-list">'
                  + suspects.map(function (sp) {
                      var cand = sp.candidates && sp.candidates[0] && sp.candidates[0].company;
                      return '<div class="fb-log-item">'
                        + '<div><b>' + esc(sp.company) + '</b>（' + esc(sp.country) + '）— ' + esc(sp.reason) + '</div>'
                        + '<select data-mig-dec="' + esc(sp.localId || sp.index) + '" data-mig-tgt="' + esc(cand ? cand.id : "") + '" style="margin-top:4px;min-height:30px;padding:2px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink)">'
                        + '  <option value="create_new">作为独立分支/新企业新建（推荐防误合）</option>'
                        + (cand ? ('  <option value="merge">确认同一企业，合并至「' + esc(cand.canonical_name) + '」</option>') : '')
                        + '  <option value="skip">暂跳过不迁入</option>'
                        + '</select></div>';
                    }).join("")
                  + '</div></div>'
                : '')
            + '<div class="pills" style="margin-top:10px"><button type="button" class="pill primary" id="btnMigStep4Commit">第 4 步：执行幂等正式迁入（保留本机原库）</button></div>'
            + '<div id="migCommitReport" style="margin-top:10px"></div>';

          document.getElementById("btnMigStep4Commit").addEventListener("click", function () {
            var decisions = {};
            prev.querySelectorAll("select[data-mig-dec]").forEach(function (sel) {
              decisions[sel.getAttribute("data-mig-dec")] = {
                action: sel.value,
                targetId: sel.getAttribute("data-mig-tgt") || "",
              };
            });
            var batchId = "mig_" + Date.now().toString(36);
            var repBox = document.getElementById("migCommitReport");
            repBox.innerHTML = '<div class="src-ok">🔄 正在按稳定 ID 幂等写入公司云端 D1…</div>';
            global.FG_CLOUD.migrateCommit(batchId, leads, compLogs, decisions).then(function (cr) {
              if (!cr.ok) {
                repBox.innerHTML = '<div class="v2-guard-bar lv-red">迁入失败：' + esc((cr.data && cr.data.error) || "错误") + '</div>';
                return;
              }
              var rp = cr.data.report;
              repBox.innerHTML =
                '<div class="v2-guard-bar lv-green">'
                + '<b>✅ 第 5–6 步迁移核对报告（批次 ' + esc(rp.batchId) + '）：</b><br>'
                + '新建主档 <b>' + rp.companiesCreated + '</b> 家 ｜ 合并主档 <b>' + rp.companiesMerged + '</b> 家 ｜ 跳过 ' + rp.companiesSkipped + ' 家 ｜ 联系人 ' + rp.contactsInserted + ' 条 ｜ 历史时间线 ' + rp.eventsInserted + ' 条 ｜ 报价 ' + rp.quotesUpserted + ' 条 ｜ 逐单合规台账 ' + rp.complianceLogsUpserted + ' 条。<br>'
                + '<b>请抽查 5–10 家重点客户确认历史与报价无损；本机原 IndexedDB 已完整保留未清空。</b>'
                + '</div>';
              toast("✅ 历史客户已安全幂等迁入公司云端！");
              loadCloudActiveTab();
              fetchCloudCompaniesForBinding(true);
            });
          });
        });
      });
    });
  }

  // ===== 5. Super-Admin / Manager Governance Modal (Plan A + S04 Complete Governance) =====
  function openAdminModal(initialTab) {
    injectModalsOnce();
    var modal = document.getElementById("cloudAdminModal");
    modal.hidden = false;
    renderAdminModal(initialTab || "emps");
  }

  function renderAdminModal(initialTab) {
    var body = document.getElementById("cloudAdminBody");
    var st = global.FG_CLOUD.getState();
    var isSuper = st.employee && st.employee.role === "super_admin";
    var startTab = (initialTab === "backup" && isSuper) ? "backup" : (initialTab === "audit" ? "audit" : "emps");

    body.innerHTML =
      '<div class="v2-guard-bar lv-yellow"><b>🛡️ 高危管理动态校验（停用成员 / 改密改额度 / 踢设备 / 备份恢复用）：</b>操作前再看手机填入当前 6 位动态码（批量开通成员可直接填在下方第 2 步）：'
      + ' <input id="inpAdminTotp" type="text" inputmode="numeric" maxlength="12" placeholder="6位动态码" style="width:125px;min-height:28px;padding:2px 8px;border:1px solid var(--orange);border-radius:6px;background:var(--surface);color:var(--ink);font-weight:800"></div>'
      + '<div class="pills" style="margin:8px 0">'
      + '  <button type="button" class="pill' + (startTab === "emps" ? ' primary' : '') + '" data-admtab="emps">👥 成员账号与设备</button>'
      + '  <button type="button" class="pill' + (startTab === "audit" ? ' primary' : '') + '" data-admtab="audit">📜 安全审计日志</button>'
      + (isSuper ? ('  <button type="button" class="pill' + (startTab === "backup" ? ' primary' : '') + '" data-admtab="backup">💾 云端备份与恢复重核验</button>') : '')
      + '</div>'
      + '<div id="cloudAdminTabBody"></div>';

    body.querySelectorAll("[data-admtab]").forEach(function (b) {
      b.addEventListener("click", function () {
        var tab = b.getAttribute("data-admtab");
        body.querySelectorAll("[data-admtab]").forEach(function (x) { x.classList.toggle("primary", x === b); });
        loadAdminTab(tab);
      });
    });
    loadAdminTab(startTab);
  }

  function getAdminTotp() {
    var el = document.getElementById("inpAdminTotp");
    return el ? el.value.trim() : "";
  }

  function loadAdminTab(tab) {
    var box = document.getElementById("cloudAdminTabBody");
    if (!box) return;
    var st = global.FG_CLOUD.getState();
    var isSuper = st.employee && st.employee.role === "super_admin";

    if (tab === "audit") {
      box.innerHTML = '<div class="src-ok">加载审计日志…</div>';
      global.FG_CLOUD.listAuditLogs(60).then(function (r) {
        if (!r.ok) { box.innerHTML = '<div class="v2-guard-bar lv-red">' + esc((r.data && r.data.error) || "失败") + '</div>'; return; }
        box.innerHTML = '<div class="fb-log-list" style="max-height:360px">'
          + (r.data.logs || []).map(function (l) {
              return '<div class="fb-log-item"><b>[' + esc(l.action) + ']</b> ' + esc(l.actor_name) + ' → ' + esc(l.target_type + ':' + l.target_id)
                + '<div class="src-ok" style="white-space:normal">' + esc(fmtBjt(l.created_at)) + ' · ' + esc(l.diff_summary || "") + '</div></div>';
            }).join("") + '</div>';
      });
      return;
    }

    if (tab === "backup") {
      box.innerHTML =
        '<div style="display:grid;gap:10px">'
        + (st.restoreFrozen ? '<div class="v2-guard-bar lv-red"><b>🔒 当前处于备份恢复冻结期！</b>所有成员业务写入已自动暂停，请完成下方「③ 恢复后强制安全重核验」以核查退订/停用保护并解冻系统。</div>' : '')
        + '<div class="fb-log-item"><b>① 导出公司云端全量逻辑备份（JSON）</b><div class="src-ok" style="white-space:normal">含全部企业主档、联系人、时间线、报价、合规台账、OSM 隔离池与反馈板（自动剔除密码哈希与 2FA 密钥；请存至公司私密网盘/硬盘，严禁上传公开仓库）。</div>'
        + '<button type="button" class="pill primary" id="btnAdminExportBak" style="margin-top:6px">💾 验证 2FA 并下载云端备份</button></div>'
        + '<div class="fb-log-item"><b>② 导入并恢复 JSON 逻辑备份快照（自动冻结写入 + 保留最新退订/阻断名单）</b>'
        + '<div class="src-ok" style="white-space:normal">选择之前导出的 JSON 备份文件并输入确认短语 <code>RESTORE_CONFIRM</code>。恢复期间服务端自动冻结全员业务接口（503），且不会让已退订或合规阻断的客户复活。</div>'
        + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:6px">'
        + '  <input id="inpAdminRestoreFile" type="file" accept=".json,application/json" style="font-size:12px;max-width:230px">'
        + '  <input id="inpAdminRestorePhrase" type="text" placeholder="输入 RESTORE_CONFIRM" style="min-height:30px;padding:2px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink);width:170px">'
        + '  <button type="button" class="pill danger" id="btnAdminDoRestore" style="min-height:30px;padding:3px 10px;font-size:12px">📥 验证 2FA 并执行恢复</button>'
        + '</div></div>'
        + '<div class="fb-log-item"><b>③ 数据库恢复后强制安全重核验并解除冻结</b><div class="src-ok" style="white-space:normal">重核验已停用成员状态、全量重建退订/合规阻断单调保护，并吊销其他设备旧会话要求重登，全部核查通过后自动解除恢复冻结。</div>'
        + '<button type="button" class="pill danger" id="btnAdminPostRestore" style="margin-top:6px">🔒 验证 2FA 并执行安全重核验（解冻）</button></div>'
        + '<div id="adminBackupOut"></div></div>';

      document.getElementById("btnAdminExportBak").addEventListener("click", function () {
        global.FG_CLOUD.exportBackup(getAdminTotp()).then(function (r) {
          if (!r.ok) { toast((r.data && r.data.error) || "导出失败，请先填 2FA 动态码"); return; }
          if (typeof global.downloadFile === "function") {
            global.downloadFile("friesgo-cloud-d1-backup-" + fmtBjt(new Date().toISOString(), { dateOnly: true }) + ".json", JSON.stringify(r.data, null, 2), "application/json;charset=utf-8");
          }
          document.getElementById("adminBackupOut").innerHTML = '<div class="v2-guard-bar lv-green">✅ 已导出逻辑备份：' + esc(JSON.stringify(r.data.counts)) + '</div>';
        });
      });

      document.getElementById("btnAdminDoRestore").addEventListener("click", function () {
        var fileInp = document.getElementById("inpAdminRestoreFile");
        var phrase = (document.getElementById("inpAdminRestorePhrase") || {}).value || "";
        var totp = getAdminTotp();
        if (!fileInp || !fileInp.files || !fileInp.files[0]) { toast("请先选择要恢复的 JSON 备份文件"); return; }
        if (phrase.trim() !== "RESTORE_CONFIRM") { toast("请在确认框准确输入 RESTORE_CONFIRM"); return; }
        var reader = new FileReader();
        reader.onload = function () {
          var parsed = null;
          try { parsed = JSON.parse(String(reader.result || "")); } catch (_) {}
          if (!parsed || !parsed.tables || typeof parsed.tables !== "object") {
            toast("所选 JSON 文件格式无效（缺少 tables 字段）");
            return;
          }
          global.FG_CLOUD.restoreBackup(totp, "RESTORE_CONFIRM", parsed.tables).then(function (r) {
            if (!r.ok) { toast((r.data && r.data.error) || "恢复失败"); return; }
            document.getElementById("adminBackupOut").innerHTML =
              '<div class="v2-guard-bar lv-yellow"><b>✅ 快照已恢复并进入安全冻结期！</b><br>'
              + '恢复行数：' + esc(JSON.stringify(r.data.restoredCounts)) + '<br>'
              + '自动保留最新退订/阻断保护：<b>' + esc((r.data.preservedProtections || []).length) + '</b> 家。<br>'
              + '<b>请立即点击上方「③ 执行安全重核验（解冻）」完成闭环！</b></div>';
            toast("✅ 备份已恢复，请立刻执行步骤 ③ 安全重核验解冻！");
          });
        };
        reader.readAsText(fileInp.files[0]);
      });

      document.getElementById("btnAdminPostRestore").addEventListener("click", function () {
        global.FG_CLOUD.postRestoreVerify(getAdminTotp(), true).then(function (r) {
          if (!r.ok) { toast((r.data && r.data.error) || "校验失败"); return; }
          document.getElementById("adminBackupOut").innerHTML = '<div class="v2-guard-bar lv-green">✅ 恢复后安全重核验已完成并解除冻结：' + esc(JSON.stringify(r.data.report)) + '</div>';
          toast("✅ 重核验通过，团队云端服务已恢复正常！");
          loadCloudActiveTab();
        });
      });
      return;
    }

    // Default: Members & Device Management (Plan A + S04 Complete Governance)
    box.innerHTML = '<div class="src-ok">加载成员列表…</div>';
    global.FG_CLOUD.listEmployees().then(function (r) {
      if (!r.ok) { box.innerHTML = '<div class="v2-guard-bar lv-red">' + esc((r.data && r.data.error) || "加载失败") + '</div>'; return; }
      var emps = r.data.employees || [];
      var createForm = isSuper
        ? ('<div style="padding:10px;border:1px dashed var(--line);border-radius:10px;background:var(--surface2);margin-bottom:10px">'
            + '<div style="display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;margin-bottom:6px">'
            + '  <span style="font-size:12.5px;font-weight:800;color:var(--brown)">第 1 步 · 先填好要开通的团队成员信息（可一次填多位）</span>'
            + '  <div class="pills" style="margin:0">'
            + '    <button type="button" class="pill" id="btnAdmAddRow" style="min-height:24px;padding:1px 8px;font-size:11.5px">＋ 加 1 行</button>'
            + '    <button type="button" class="pill" id="btnAdmAdd5Rows" style="min-height:24px;padding:1px 8px;font-size:11.5px">⚡ 补齐 5 行</button>'
            + '    <button type="button" class="pill" id="btnAdmTogglePwdVis" style="min-height:24px;padding:1px 8px;font-size:11.5px">👁️ 显示密码</button>'
            + '  </div>'
            + '</div>'
            + '<div id="admBatchRows" style="display:grid;gap:6px">'
            + '  <div class="adm-emp-row form-grid-4" style="gap:6px;align-items:center">'
            + '    <input id="admNewLogin" data-f="login" type="text" placeholder="登录名（如 lisi）" style="min-height:32px;padding:3px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink)">'
            + '    <input id="admNewName" data-f="name" type="text" placeholder="真实姓名（如 李四）" style="min-height:32px;padding:3px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink)">'
            + '    <input id="admNewPwd" data-f="pwd" type="password" placeholder="初始密码（8位+字母数字）" style="min-height:32px;padding:3px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink)">'
            + '    <select id="admNewRole" data-f="role" style="min-height:32px;padding:3px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink)"><option value="staff">业务成员 (staff)</option><option value="manager">业务主管 (manager)</option></select>'
            + '  </div>'
            + '</div>'
            + '<div style="margin-top:10px;padding-top:8px;border-top:1px dashed var(--line);display:flex;gap:8px;flex-wrap:wrap;align-items:center">'
            + '  <span style="font-size:12px;font-weight:800;color:var(--brown)">第 2 步 · 全部填完后，再看手机填当前 6 位动态码：</span>'
            + '  <input id="inpAdmCreateTotp" type="text" inputmode="numeric" maxlength="12" placeholder="6位动态码" style="width:125px;min-height:32px;padding:3px 8px;border:1px solid var(--orange);border-radius:6px;background:var(--surface);color:var(--ink);font-weight:800">'
            + '  <button type="button" class="pill primary" id="btnAdmCreateEmp" style="min-height:32px;padding:4px 14px;font-size:12.5px">✅ 确认开通以上成员账号</button>'
            + '</div>'
            + '<div id="admCreateMsg" style="margin-top:6px;font-size:12px;font-weight:700"></div>'
            + '</div>')
        : '';

      box.innerHTML = createForm
        + '<div class="fb-log-list" style="max-height:380px">'
        + emps.map(function (e) {
            var isAct = e.status === "active";
            var capVal = Number(e.gmaps_monthly_cap);
            var capText = capVal === 0 ? "0 次（已禁用代理）" : (capVal + " 次");
            return '<div class="fb-log-item" data-emp-card="' + esc(e.id) + '">'
              + '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">'
              + '  <div><b>' + esc(e.display_name) + '</b> (<code>' + esc(e.login_id) + '</code>) · <span class="meta-pill" style="padding:1px 6px;font-size:11px">' + esc(roleLabel(e.role)) + '</span> '
              + (isAct ? '<span class="mx-ok">启用中</span>' : '<span class="comp-tag comp-red">已停用</span>')
              + '  <div class="src-ok">在线设备 ' + esc(e.active_sessions || 0) + ' 台 · Google月额度 ' + esc(capText) + (e.totp_enabled ? ' · 🔐 2FA已启用' : '') + '</div></div>'
              + (isSuper && e.role !== "super_admin"
                  ? ('<div class="pills" style="margin:0">'
                      + '<button type="button" class="pill" data-adm-resetpwd="' + esc(e.id) + '" style="min-height:26px;padding:2px 8px;font-size:11.5px">🔑 重置密码</button>'
                      + '<button type="button" class="pill" data-adm-editcap="' + esc(e.id) + '" data-cur-role="' + esc(e.role) + '" data-cur-cap="' + esc(capVal) + '" style="min-height:26px;padding:2px 8px;font-size:11.5px">⚙️ 角色/额度</button>'
                      + '<button type="button" class="pill" data-adm-sessions="' + esc(e.id) + '" style="min-height:26px;padding:2px 8px;font-size:11.5px">📱 查设备</button>'
                      + '<button type="button" class="pill ' + (isAct ? 'danger' : 'good-btn') + '" data-adm-toggle="' + esc(e.id) + '" data-next-st="' + (isAct ? 'disabled' : 'active') + '" style="min-height:26px;padding:2px 8px;font-size:11.5px">' + (isAct ? '停用并踢下线' : '恢复启用') + '</button>'
                      + '<button type="button" class="pill" data-adm-kick="' + esc(e.id) + '" style="min-height:26px;padding:2px 8px;font-size:11.5px">全设备踢下线</button>'
                      + '</div>')
                  : '')
              + '</div>'
              + '<div class="adm-emp-drawer" id="admDrawer_' + esc(e.id) + '" hidden style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--line)"></div>'
              + '</div>';
          }).join("")
        + '</div>';

      var pwdShowing = false;
      function appendEmpRow() {
        var rowsWrap = document.getElementById("admBatchRows");
        if (!rowsWrap) return;
        if (rowsWrap.querySelectorAll(".adm-emp-row").length >= 20) {
          toast("单次批量最多添加 20 位成员");
          return;
        }
        var row = document.createElement("div");
        row.className = "adm-emp-row form-grid-4";
        row.style.cssText = "gap:6px;align-items:center";
        row.innerHTML =
          '<input data-f="login" type="text" placeholder="登录名（英文/拼音）" style="min-height:32px;padding:3px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink)">'
          + '<input data-f="name" type="text" placeholder="真实姓名" style="min-height:32px;padding:3px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink)">'
          + '<input data-f="pwd" type="' + (pwdShowing ? "text" : "password") + '" placeholder="初始密码（8位+字母数字）" style="min-height:32px;padding:3px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink)">'
          + '<div style="display:flex;gap:4px;align-items:center">'
          + '  <select data-f="role" style="flex:1;min-width:0;min-height:32px;padding:3px 6px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink)"><option value="staff">业务成员 (staff)</option><option value="manager">业务主管 (manager)</option></select>'
          + '  <button type="button" class="pill" data-rm-row="1" title="移除此行" style="min-height:30px;padding:2px 7px;font-size:12px">×</button>'
          + '</div>';
        row.querySelector("[data-rm-row]").addEventListener("click", function () { row.remove(); });
        rowsWrap.appendChild(row);
      }

      var btnTogPwd = document.getElementById("btnAdmTogglePwdVis");
      if (btnTogPwd) {
        btnTogPwd.addEventListener("click", function () {
          pwdShowing = !pwdShowing;
          btnTogPwd.textContent = pwdShowing ? "🙈 隐藏密码" : "👁️ 显示密码";
          var rowsWrap = document.getElementById("admBatchRows");
          if (rowsWrap) {
            rowsWrap.querySelectorAll('input[data-f="pwd"]').forEach(function (el) {
              el.type = pwdShowing ? "text" : "password";
            });
          }
        });
      }
      var btnAddRow = document.getElementById("btnAdmAddRow");
      if (btnAddRow) btnAddRow.addEventListener("click", appendEmpRow);
      var btnAdd5 = document.getElementById("btnAdmAdd5Rows");
      if (btnAdd5) {
        btnAdd5.addEventListener("click", function () {
          var rowsWrap = document.getElementById("admBatchRows");
          if (!rowsWrap) return;
          while (rowsWrap.querySelectorAll(".adm-emp-row").length < 5) appendEmpRow();
        });
      }

      var btnCr = document.getElementById("btnAdmCreateEmp");
      if (btnCr) {
        btnCr.addEventListener("click", function () {
          var msgEl = document.getElementById("admCreateMsg");
          var rowsWrap = document.getElementById("admBatchRows");
          var rows = rowsWrap ? Array.prototype.slice.call(rowsWrap.querySelectorAll(".adm-emp-row")) : [];
          var filled = [];
          rows.forEach(function (row) {
            var lid = (row.querySelector('[data-f="login"]') || {}).value || "";
            var nm = (row.querySelector('[data-f="name"]') || {}).value || "";
            var pw = (row.querySelector('[data-f="pwd"]') || {}).value || "";
            var rl = (row.querySelector('[data-f="role"]') || {}).value || "staff";
            if (lid.trim() || nm.trim() || pw.trim()) {
              filled.push({ login_id: lid.trim(), display_name: nm.trim(), password: pw, role: rl });
            }
          });
          if (!filled.length) {
            toast("请先在第 1 步填写至少 1 位成员的登录名、姓名与初始密码");
            return;
          }
          var inlineTotpEl = document.getElementById("inpAdmCreateTotp");
          var totpVal = (inlineTotpEl && inlineTotpEl.value.trim()) || getAdminTotp();
          if (!totpVal) {
            if (msgEl) { msgEl.style.color = "var(--danger)"; msgEl.textContent = "请看手机验证器，在第 2 步填入当前 6 位动态验证码后再点确认开通"; }
            toast("请先在第 2 步输入当前 6 位动态验证码");
            if (inlineTotpEl) inlineTotpEl.focus();
            return;
          }
          if (msgEl) { msgEl.style.color = "var(--muted)"; msgEl.textContent = "正在验证 2FA 并开通 " + filled.length + " 位成员账号…"; }
          btnCr.disabled = true;
          var req = filled.length === 1
            ? global.FG_CLOUD.createEmployee(Object.assign({}, filled[0], { totp_code: totpVal }))
            : global.FG_CLOUD.createEmployeesBatch(filled, totpVal);
          req.then(function (res) {
            btnCr.disabled = false;
            if (!res.ok) {
              var errTxt = (res.data && res.data.error) || "开通失败";
              if (msgEl) { msgEl.style.color = "var(--danger)"; msgEl.textContent = "❌ " + errTxt; }
              toast(errTxt);
              return;
            }
            if (inlineTotpEl) inlineTotpEl.value = "";
            if (filled.length === 1) {
              toast("✅ 已开通成员账号：" + (res.data.employee && res.data.employee.display_name));
            } else {
              toast("✅ 一次 2FA 验证成功！已批量开通 " + (res.data.count || filled.length) + " 位成员独立账号");
            }
            loadAdminTab("emps");
          });
        });
      }

      // S04: Inline Reset Password
      box.querySelectorAll("[data-adm-resetpwd]").forEach(function (b) {
        b.addEventListener("click", function () {
          var eid = b.getAttribute("data-adm-resetpwd");
          var dr = document.getElementById("admDrawer_" + eid);
          if (!dr) return;
          dr.hidden = false;
          var inpId = "admResetPwdInp_" + eid;
          dr.innerHTML =
            '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">'
            + '  <input id="' + esc(inpId) + '" type="password" placeholder="新密码（8位以上含字母与数字）" style="flex:1;min-width:170px;min-height:30px;padding:3px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink)">'
            + '  <button type="button" class="pill" data-toggle-pwd="' + esc(inpId) + '" style="min-height:30px;padding:2px 8px;font-size:11.5px">👁️ 显示</button>'
            + '  <button type="button" class="pill primary" data-do-resetpwd="' + esc(eid) + '" style="min-height:30px;padding:2px 10px;font-size:11.5px">确认重置并踢旧设备</button>'
            + '</div>';
          wirePwdToggleButtons(dr);
          dr.querySelector("[data-do-resetpwd]").addEventListener("click", function () {
            var np = document.getElementById(inpId).value;
            global.FG_CLOUD.updateEmployee(eid, { reset_password: np, totp_code: getAdminTotp() }).then(function (res) {
              if (!res.ok) { toast((res.data && res.data.error) || "重置失败，请先在顶部填入 6 位动态码"); return; }
              toast("✅ 已重置该成员密码并自动吊销其所有旧设备会话");
              loadAdminTab("emps");
            });
          });
        });
      });

      // S04 + D07: Inline Role & Google Monthly Quota Cap (supports exact 0 = disabled!)
      box.querySelectorAll("[data-adm-editcap]").forEach(function (b) {
        b.addEventListener("click", function () {
          var eid = b.getAttribute("data-adm-editcap");
          var curRole = b.getAttribute("data-cur-role") || "staff";
          var curCap = b.getAttribute("data-cur-cap");
          var dr = document.getElementById("admDrawer_" + eid);
          if (!dr) return;
          dr.hidden = false;
          dr.innerHTML =
            '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">'
            + '  <select id="admEditRole_' + esc(eid) + '" style="min-height:30px;padding:2px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink)">'
            + '    <option value="staff"' + (curRole === "staff" ? " selected" : "") + '>业务成员 (staff)</option>'
            + '    <option value="manager"' + (curRole === "manager" ? " selected" : "") + '>业务主管 (manager)</option>'
            + '  </select>'
            + '  <label style="font-size:12px;color:var(--muted)">Google月额度（0=禁用，上限950）：</label>'
            + '  <input id="admEditCap_' + esc(eid) + '" type="number" min="0" max="950" step="1" value="' + esc(curCap) + '" style="width:90px;min-height:30px;padding:2px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink)">'
            + '  <button type="button" class="pill primary" data-do-savecap="' + esc(eid) + '" style="min-height:30px;padding:2px 10px;font-size:11.5px">保存角色/额度</button>'
            + '</div>';
          dr.querySelector("[data-do-savecap]").addEventListener("click", function () {
            var roleVal = document.getElementById("admEditRole_" + eid).value;
            var capRaw = document.getElementById("admEditCap_" + eid).value.trim();
            var capNum = Number(capRaw);
            if (capRaw === "" || !Number.isInteger(capNum) || capNum < 0 || capNum > 950) {
              toast("月度配额必须为 0–950 之间的整数");
              return;
            }
            global.FG_CLOUD.updateEmployee(eid, { role: roleVal, gmaps_monthly_cap: capNum, totp_code: getAdminTotp() }).then(function (res) {
              if (!res.ok) { toast((res.data && res.data.error) || "更新失败，请先在顶部填入 6 位动态码"); return; }
              toast("✅ 已更新成员角色与月度配额（" + capNum + " 次）");
              loadAdminTab("emps");
            });
          });
        });
      });

      // S04: Inline Single-Device Session Inspection & Per-Device Kick
      box.querySelectorAll("[data-adm-sessions]").forEach(function (b) {
        b.addEventListener("click", function () {
          var eid = b.getAttribute("data-adm-sessions");
          var dr = document.getElementById("admDrawer_" + eid);
          if (!dr) return;
          dr.hidden = false;
          dr.innerHTML = '<div class="src-ok">🔄 加载在线设备…</div>';
          global.FG_CLOUD.listEmployeeSessions(eid).then(function (res) {
            if (!res.ok) { dr.innerHTML = '<div style="color:var(--danger);font-size:12px">' + esc((res.data && res.data.error) || "加载失败") + '</div>'; return; }
            var ss = res.data.sessions || [];
            if (!ss.length) {
              dr.innerHTML = '<div class="src-ok">该成员当前没有活跃设备会话。</div>';
              return;
            }
            dr.innerHTML = ss.map(function (s) {
              return '<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;padding:3px 0">'
                + '<span class="src-ok">📱 <b>' + esc(s.device_label || "Web") + '</b> · 最近活跃 ' + esc(fmtBjt(s.last_seen_at)) + '</span>'
                + '<button type="button" class="pill danger" data-kick-one-sid="' + esc(s.session_id) + '" style="min-height:24px;padding:1px 8px;font-size:11px">踢此设备</button>'
                + '</div>';
            }).join("");
            dr.querySelectorAll("[data-kick-one-sid]").forEach(function (kb) {
              kb.addEventListener("click", function () {
                global.FG_CLOUD.revokeEmployeeSessions(eid, {
                  session_id: kb.getAttribute("data-kick-one-sid"),
                  totp_code: getAdminTotp(),
                }).then(function (kr) {
                  if (!kr.ok) { toast((kr.data && kr.data.error) || "踢设备失败，请先填顶部 6 位动态码"); return; }
                  toast("✅ 已单独踢下线该设备");
                  loadAdminTab("emps");
                });
              });
            });
          });
        });
      });

      box.querySelectorAll("[data-adm-toggle]").forEach(function (b) {
        b.addEventListener("click", function () {
          global.FG_CLOUD.updateEmployee(b.getAttribute("data-adm-toggle"), {
            status: b.getAttribute("data-next-st"),
            totp_code: getAdminTotp(),
          }).then(function (res) {
            if (!res.ok) { toast((res.data && res.data.error) || "操作失败，请填 2FA 动态码"); return; }
            toast("✅ 已更新成员状态");
            loadAdminTab("emps");
          });
        });
      });
      box.querySelectorAll("[data-adm-kick]").forEach(function (b) {
        b.addEventListener("click", function () {
          global.FG_CLOUD.revokeEmployeeSessions(b.getAttribute("data-adm-kick"), {
            totp_code: getAdminTotp(),
          }).then(function (res) {
            if (!res.ok) { toast((res.data && res.data.error) || "操作失败，请填 2FA 动态码"); return; }
            toast("✅ 已撤销该成员全部在线设备会话");
            loadAdminTab("emps");
          });
        });
      });
    });
  }

  // ===== 6. Cloud Co-Creation Feedback Board inside #feedbackModal =====
  function loadCloudFeedbackBoard() {
    var st = global.FG_CLOUD.getState();
    var listEl = document.getElementById("fbCloudBoardList");
    if (!listEl || !st.loggedIn || st.requireTotpSetup) return;
    var isAdmin = st.employee && (st.employee.role === "super_admin" || st.employee.role === "manager");
    listEl.innerHTML = '<div class="src-ok">🔄 加载团队共建整改榜…</div>';
    global.FG_CLOUD.listCloudFeedback("all").then(function (r) {
      if (!r.ok) { listEl.innerHTML = '<div class="src-ok">暂无法加载云端整改榜</div>'; return; }
      var items = r.data.items || [];
      if (!items.length) {
        listEl.innerHTML = '<div class="src-ok">暂无团队云端建议，欢迎提交第一条改进建议！</div>';
        return;
      }
      listEl.innerHTML = items.slice(0, 20).map(function (it) {
        var si = FB_STATUS_LABELS[it.status] || FB_STATUS_LABELS.open;
        return '<div class="fb-log-item">'
          + '<div style="display:flex;justify-content:space-between;gap:6px;flex-wrap:wrap">'
          + '  <div><b>[' + esc(it.category) + ']</b> ' + esc(it.employee_name) + ' · <span class="' + si.cls + '" style="font-size:11px">' + esc(si.txt) + '</span></div>'
          + '  <span class="src-ok">' + esc(fmtBjt(it.created_at, { dateOnly: true })) + '</span>'
          + '</div>'
          + '<div style="margin-top:3px">' + esc(it.content) + '</div>'
          + (it.admin_reply ? ('<div style="margin-top:3px;color:var(--good);font-weight:700">💬 负责人回复：' + esc(it.admin_reply) + '</div>') : '')
          + (isAdmin
              ? ('<div style="margin-top:5px;display:flex;gap:4px;flex-wrap:wrap">'
                  + '<button type="button" class="pill" data-fb-st="' + esc(it.id) + '" data-st="planned" style="min-height:22px;padding:1px 7px;font-size:11px">标为已采纳</button>'
                  + '<button type="button" class="pill good-btn" data-fb-st="' + esc(it.id) + '" data-st="shipped" style="min-height:22px;padding:1px 7px;font-size:11px">标为已上线</button>'
                  + '</div>')
              : '')
          + '</div>';
      }).join("");
      listEl.querySelectorAll("[data-fb-st]").forEach(function (b) {
        b.addEventListener("click", function () {
          var id = b.getAttribute("data-fb-st");
          var nextSt = b.getAttribute("data-st");
          global.FG_CLOUD.updateCloudFeedback(id, { status: nextSt }).then(function (res) {
            if (res.ok) { toast("已更新整改榜状态"); loadCloudFeedbackBoard(); }
          });
        });
      });
    });
  }

  // ===== 7. In-Place Map Scraper Pool Match Badges, OSM Pool Ingest & Cloud Direct Save (D09) =====
  function saveMapLeadToCloud(lead) {
    var st = global.FG_CLOUD ? global.FG_CLOUD.getState() : { loggedIn: false };
    if (!st.loggedIn || st.requireTotpSetup) return Promise.resolve({ ok: false, notLoggedIn: true });
    var rawSrc = (lead && lead.source) || "manual";
    var srcType = (rawSrc === "osm" || rawSrc === "customs_csv" || rawSrc === "worldbank" || rawSrc === "expo" || rawSrc === "website") ? rawSrc : "manual";
    return global.FG_CLOUD.createCompany({
      canonical_name: String((lead && lead.company) || "").trim(),
      country_en: String((lead && lead.country) || "").trim(),
      city: String((lead && lead.city) || "").trim(),
      address: String((lead && lead.address) || "").trim(),
      website: String((lead && lead.website) || "").trim(),
      email: String((lead && lead.email) || "").trim(),
      phone: String((lead && lead.phone) || "").trim(),
      product_summary: String((lead && (lead.product || lead.type)) || "").trim(),
      note: String((lead && lead.note) || "").trim(),
      source_type: srcType,
    }).then(function (r) {
      if (r.ok) {
        toast("☁️ 已直接保存至公司云端公海库（团队立即可见）");
        loadCloudActiveTab();
        fetchCloudCompaniesForBinding(true);
      } else if (r.status === 409 && r.data && r.data.code === "DUPLICATE_HIGH_MATCH") {
        toast("ℹ️ " + r.data.error);
      } else if (r.status === 409 && r.data && r.data.code === "DUPLICATE_SUSPECT_REVIEW") {
        toast("⚠️ " + r.data.error);
      } else {
        toast((r.data && r.data.error) || "保存云端公海失败");
      }
      return r;
    });
  }

  function onMapResultsRendered(source, leads, meta) {
    var st = global.FG_CLOUD.getState();
    var btnOsmIng = document.getElementById("btnIngestOsmCloud");
    if (btnOsmIng) {
      btnOsmIng.hidden = !(st.loggedIn && !st.requireTotpSetup && source === "osm" && Array.isArray(leads) && leads.length > 0);
      btnOsmIng._osmLeads = (source === "osm") ? leads : [];
    }
    if (!st.loggedIn || st.requireTotpSetup || !Array.isArray(leads) || !leads.length) return;

    if (meta && meta.country) {
      global.FG_CLOUD.logScrapeTask({
        country_en: meta.country,
        city: meta.city || "",
        radius_km: meta.radiusKm || 30,
        keyword: meta.keyword || "",
        engine: source === "gmaps" ? "gmaps" : "osm",
        raw_count: leads.length,
      });
    }

    var sample = leads.slice(0, 80).map(function (r) {
      return {
        company: r.company || "",
        country: r.country || "",
        city: r.city || "",
        website: r.website || "",
        email: r.email || "",
        phone: r.phone || "",
        google_place_id: r.placeId || "",
      };
    });
    global.FG_CLOUD.dedupeBatch(sample).then(function (res) {
      if (!res.ok || !res.data || !Array.isArray(res.data.results)) return;
      var wrap = document.getElementById("msResultWrap");
      if (!wrap) return;
      var trs = wrap.querySelectorAll(".ms-table-view tbody tr");
      var cards = wrap.querySelectorAll(".ms-card-list .ms-card");
      res.data.results.forEach(function (d) {
        if (!d || d.status === "new") return;
        var badgeHtml = "";
        if (d.status === "high_match" && d.match) {
          var si = STATUS_LABELS[d.match.derived_contact_status] || STATUS_LABELS.uncontacted;
          badgeHtml = ' <span class="' + si.cls + '" style="font-size:11px" title="' + esc(d.reason) + '">公海已有·' + esc(si.txt) + '</span>';
        } else if (d.status === "suspect_duplicate") {
          badgeHtml = ' <span class="mx-warn" style="font-size:11px" title="' + esc(d.reason) + '">⚠️ 公海疑似重复</span>';
        }
        if (!badgeHtml) return;
        if (trs[d.index] && trs[d.index].firstElementChild) {
          trs[d.index].firstElementChild.insertAdjacentHTML("beforeend", badgeHtml);
        }
        if (cards[d.index]) {
          var titleEl = cards[d.index].querySelector(".ms-card-title");
          if (titleEl) titleEl.insertAdjacentHTML("beforeend", badgeHtml);
        }
      });
    });
  }

  // ===== Boot Wiring =====
  function bootCloudUi() {
    if (!global.FG_CLOUD) return;
    injectModalsOnce();

    ["btnCloudAuth", "btnFooterCloudAuth"].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) b.addEventListener("click", function () { openAuthModal(); });
    });

    if (typeof window !== "undefined") {
      var resizeTimer = null;
      window.addEventListener("resize", function () {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () {
          renderTopbarAuthState(global.FG_CLOUD.getState());
        }, 120);
      });
    }

    var modePills = document.getElementById("cloudPoolModePills");
    if (modePills) {
      modePills.addEventListener("click", function (e) {
        var b = e.target.closest("button[data-cmode]");
        if (!b) return;
        uiState.crmMode = b.getAttribute("data-cmode");
        uiState.pageOffset = 0;
        syncCrmModeVisibility();
        if (uiState.crmMode !== "local") loadCloudActiveTab();
      });
    }

    ["cloudPoolCountry", "cloudPoolStage", "cloudPoolStatus"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener("change", function () { uiState.pageOffset = 0; loadCloudActiveTab(); });
    });
    var searchInp = document.getElementById("cloudPoolSearch");
    if (searchInp) {
      var timer = null;
      searchInp.addEventListener("input", function () {
        clearTimeout(timer);
        timer = setTimeout(function () { uiState.pageOffset = 0; loadCloudActiveTab(); }, 260);
      });
    }

    var btnNew = document.getElementById("btnCloudNewCompany");
    var addBox = document.getElementById("cloudAddCompBox");
    if (btnNew && addBox) {
      btnNew.addEventListener("click", function () { addBox.hidden = !addBox.hidden; });
    }
    var btnSaveNew = document.getElementById("btnCloudSaveNewComp");
    if (btnSaveNew) {
      btnSaveNew.addEventListener("click", function () {
        var nm = document.getElementById("cloudNewCompName").value.trim();
        var ct = document.getElementById("cloudNewCompCountry").value.trim();
        var city = document.getElementById("cloudNewCompCity").value.trim();
        var web = document.getElementById("cloudNewCompWeb").value.trim();
        var em = document.getElementById("cloudNewCompEmail").value.trim();
        var prod = document.getElementById("cloudNewCompProd").value.trim();
        global.FG_CLOUD.createCompany({
          canonical_name: nm,
          country_en: ct,
          city: city,
          website: web,
          email: em,
          product_summary: prod,
          source_type: "manual",
        }).then(function (r) {
          if (!r.ok) {
            toast((r.data && r.data.error) || "建档失败");
            return;
          }
          toast("✅ 已建档到公司云端公海库（团队立即可见）");
          ["cloudNewCompName", "cloudNewCompCity", "cloudNewCompWeb", "cloudNewCompEmail", "cloudNewCompProd"].forEach(function (id) {
            var x = document.getElementById(id);
            if (x) x.value = "";
          });
          if (addBox) addBox.hidden = true;
          loadCloudActiveTab();
          fetchCloudCompaniesForBinding(true);
        });
      });
    }

    var btnMigShort = document.getElementById("btnCloudOpenMigrate");
    if (btnMigShort) btnMigShort.addEventListener("click", openMigrateModal);

    var btnOsmIng = document.getElementById("btnIngestOsmCloud");
    if (btnOsmIng) {
      btnOsmIng.addEventListener("click", function () {
        var list = btnOsmIng._osmLeads || [];
        if (!list.length) return;
        global.FG_CLOUD.ingestOsmPool(list).then(function (r) {
          if (!r.ok) { toast((r.data && r.data.error) || "沉淀失败"); return; }
          toast("✅ 已沉淀 " + (r.data.ingested || 0) + " 家至 OSM 待核实线索池（ODbL 物理隔离表）");
        });
      });
    }

    var btnFbCloud = document.getElementById("btnFbSubmitCloud");
    if (btnFbCloud) {
      btnFbCloud.addEventListener("click", function () {
        var msgEl = document.getElementById("fbMessage");
        var catEl = document.getElementById("fbCategory");
        var rawMsg = (msgEl ? msgEl.value : "").trim();
        if (!rawMsg) { toast("请先用一句话写下问题或建议"); return; }
        if (typeof global._checkFeedbackPrivacyGuard === "function" && !global._checkFeedbackPrivacyGuard()) {
          return;
        }
        var buildVer = (global.FG_BUILD_META && global.FG_BUILD_META.version) || "v2.1-m2a";
        global.FG_CLOUD.submitCloudFeedback({
          category: catEl ? catEl.value : "新功能建议",
          content: rawMsg,
          context: {
            viewport: (window.innerWidth || 0) + "x" + (window.innerHeight || 0),
            appVersion: buildVer,
          },
        }).then(function (r) {
          if (!r.ok) { toast((r.data && r.data.error) || "云端提交失败"); return; }
          if (msgEl) msgEl.value = "";
          toast("🚀 已提交至团队云端共建整改榜（自动脱敏）");
          loadCloudFeedbackBoard();
        });
      });
    }

    ["btnOpenFeedback", "btnFooterFeedback"].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) b.addEventListener("click", function () { setTimeout(loadCloudFeedbackBoard, 40); });
    });

    if (global.FG_GEO && typeof global.FG_GEO.populateCountrySelect === "function") {
      var pCtry = document.getElementById("cloudPoolCountry");
      if (pCtry) {
        global.FG_GEO.populateCountrySelect(pCtry, "Vietnam");
        var optAll = document.createElement("option");
        optAll.value = "ALL";
        optAll.textContent = "🌍 全部国家公海";
        pCtry.insertBefore(optAll, pCtry.firstChild);
        pCtry.value = "ALL";
      }
      var nCtry = document.getElementById("cloudNewCompCountry");
      if (nCtry) global.FG_GEO.populateCountrySelect(nCtry, "Vietnam");
    }

    global.FG_CLOUD.subscribe(function (st, evType) {
      renderTopbarAuthState(st);
      if (evType === "cleared" && st.lastError) {
        toast("⚠️ " + st.lastError + "，已清除本机私有缓存");
      }
    });

    var initSt = global.FG_CLOUD.getState();
    renderTopbarAuthState(initSt);
    if (initSt.loggedIn) {
      global.FG_CLOUD.refreshMe().then(function (r) {
        if (r.ok && !global.FG_CLOUD.getState().requireTotpSetup) {
          global.FG_CLOUD.flushPendingQueue().then(function () {
            loadCloudActiveTab();
            fetchCloudCompaniesForBinding(true);
          });
        }
      });
    }
  }

  global.FG_CLOUD_UI = {
    boot: bootCloudUi,
    fmtBjt: fmtBjt,
    roleLabel: roleLabel,
    openAuthModal: openAuthModal,
    openMigrateModal: openMigrateModal,
    openAdminModal: openAdminModal,
    openCloudCompanyDetail: openCloudCompanyDetail,
    loadCloudActiveTab: loadCloudActiveTab,
    loadCloudFeedbackBoard: loadCloudFeedbackBoard,
    onMapResultsRendered: onMapResultsRendered,
    saveMapLeadToCloud: saveMapLeadToCloud,
    fetchCloudCompaniesForBinding: fetchCloudCompaniesForBinding,
    getCachedCloudCompanies: function () { return uiState.bindingCache.slice(); },
    getCachedCloudTotal: function () { return uiState.bindingTotal; },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootCloudUi);
  } else {
    setTimeout(bootCloudUi, 0);
  }
})(typeof window !== "undefined" ? window : globalThis);
