/* FriesGo Global V3.0 Slice 1: Operational Growth, Social Demand Discovery & Partner Hub UI
 * Zero external dependencies. Mobile-ready down to 360px with 0px horizontal overflow, light/dark theme native.
 * 6 Role-Aware Operational Views:
 *   1. todos    - Today's Action Queue, Manager Dispatch/Reassign/Quote, Atomic Accept/Reject, Personal WeChat Desensitized Card (UX02/ENG01/ENG06)
 *   2. tasks    - FB / IG / LI Discovery Tasks (API status honestly marked "人工工作流 / API待授权"; YouTube future), Hours & Spend (ACQ01-03)
 *   3. signals  - Candidate Intake (account/org scoped drafts), 4-tier Audit, Editable Reply Draft vs Confirmed Manual Send, Opt-out (ACQ04-09)
 *   4. compare  - Source Comparison with Honest Denominators, Small-Sample Warning, YouTube Exclusion & Weekly Markdown Copy (ACQ10)
 *   5. projects - Lightweight Projects & Multi-Company Buyer Roles + 3-Tier Blind-Dedupe Deal Reg & Manager Adjudication (UX03/UX05/REV07-08)
 *   6. admin    - Applications Review & Separated Activation, Approved Product Catalog/Certs Manager, Independent Space Support Grants (REV09/NEW01/REV01)
 */
(function (global) {
  "use strict";

  var modalEl = null;
  var activeTab = "todos"; // todos | tasks | signals | compare | projects | admin
  var todoBucketFilter = "all";
  var sigFilters = { platform: "", audit_status: "", contact_result: "" };
  var cmpFilters = { country: "", product_line: "" };

  function esc(s) {
    return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c];
    });
  }

  function copyText(text, successMsg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast(successMsg || "已复制到剪贴板");
      }).catch(function () {
        toast("复制失败，请手动选中复制");
      });
    } else {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        toast(successMsg || "已复制到剪贴板");
      } catch (_) {
        toast("当前浏览器不支持自动复制，请手动复制");
      }
    }
  }

  function toast(msg) {
    if (typeof global.showToast === "function") global.showToast(msg);
    if (modalEl) {
      var bar = modalEl.querySelector("#v3ToastBar");
      if (bar) {
        bar.textContent = msg;
        bar.hidden = false;
        clearTimeout(bar._t);
        bar._t = setTimeout(function () { bar.hidden = true; }, 4000);
      }
    }
  }

  function injectStylesOnce() {
    if (document.getElementById("fgV3HubStyles")) return;
    var st = document.createElement("style");
    st.id = "fgV3HubStyles";
    st.textContent =
      "#v3GrowthHubBackdrop{padding:8px}" +
      "#v3GrowthHubBackdrop *{box-sizing:border-box}" +
      ".v3-dialog{max-width:1080px;width:100%;max-height:94vh;display:flex;flex-direction:column;gap:10px;overflow:hidden}" +
      ".v3-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:8px}" +
      ".v3-head h3{margin:0;font-size:16px;color:var(--brown);line-height:1.3}" +
      ".v3-tabs{display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:8px}" +
      ".v3-tabs .pill{min-height:34px;padding:4px 10px;font-size:12.5px}" +
      ".v3-body{overflow-y:auto;overflow-x:hidden;flex:1;min-height:280px;padding-right:2px}" +
      ".v3-card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:10px;max-width:100%;overflow-wrap:anywhere}" +
      ".v3-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}" +
      ".v3-grid-3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}" +
      ".v3-plat-strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-bottom:10px}" +
      ".v3-plat-box{background:var(--surface2);border:1px solid var(--line);border-radius:10px;padding:8px 10px;font-size:12px;line-height:1.45}" +
      ".v3-plat-box.is-future{border-style:dashed;opacity:.85}" +
      ".v3-chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}" +
      ".v3-chip{border:1px solid var(--line);background:var(--surface2);color:var(--brown);border-radius:999px;padding:4px 10px;min-height:32px;font-size:12px;font-weight:700;cursor:pointer}" +
      ".v3-chip.active{background:var(--brown);color:var(--bg);border-color:var(--brown)}" +
      ".v3-filter-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px;padding:8px 10px;background:var(--surface2);border:1px solid var(--line);border-radius:10px}" +
      ".v3-filter-bar select,.v3-filter-bar input{min-height:34px;padding:4px 8px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink);font-size:12.5px;max-width:100%}" +
      ".v3-acts{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;align-items:center}" +
      ".v3-acts .pill{min-height:32px;padding:3px 10px;font-size:12px}" +
      ".v3-field label{display:block;font-size:12px;font-weight:700;color:var(--brown);margin-bottom:3px}" +
      ".v3-field input,.v3-field select,.v3-field textarea{width:100%;max-width:100%;min-height:36px;padding:6px 9px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink);font-size:13px}" +
      ".v3-field textarea{min-height:68px;resize:vertical}" +
      ".v3-draft-box{margin-top:8px;padding:10px;border-radius:10px;background:var(--surface2);border:1px dashed var(--orange)}" +
      ".v3-draft-box textarea{width:100%;min-height:92px;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink);font-size:12.5px}" +
      ".v3-wx-pre{margin-top:8px;padding:8px 10px;border-radius:8px;background:var(--surface2);border:1px dashed var(--line);font-size:12px;white-space:pre-wrap;word-break:break-word}" +
      ".v3-badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11.5px;font-weight:700;background:var(--surface2);border:1px solid var(--line);color:var(--brown)}" +
      ".v3-badge.ok{background:var(--good-bg);border-color:var(--good);color:var(--good)}" +
      ".v3-badge.warn{background:var(--orange-soft);border-color:var(--orange);color:var(--high)}" +
      ".v3-badge.err{background:var(--danger-bg);border-color:var(--danger);color:var(--danger)}" +
      ".v3-table-wrap{width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}" +
      ".v3-table-wrap table{width:100%;border-collapse:collapse;font-size:12.5px}" +
      ".v3-table-wrap th,.v3-table-wrap td{padding:7px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}" +
      "@media(max-width:680px){" +
      "  .v3-grid,.v3-grid-3,.v3-plat-strip{grid-template-columns:1fr}" +
      "  .v3-dialog{padding:12px}" +
      "  #v3ContextSelect{width:100%}" +
      "}";
    document.head.appendChild(st);
  }

  function ensureModal() {
    injectStylesOnce();
    if (modalEl) return modalEl;
    modalEl = document.createElement("div");
    modalEl.id = "v3GrowthHubBackdrop";
    modalEl.className = "fg-modal-backdrop";
    modalEl.hidden = true;
    modalEl.innerHTML =
      '<div class="fg-modal-dialog v3-dialog">' +
      '  <div class="v3-head">' +
      '    <div style="min-width:0;flex:1 1 240px">' +
      '      <h3>🤝 社媒需求发现 · 来源比较与伙伴协作中心 (V3 Slice 1)</h3>' +
      '      <div style="font-size:12px;color:var(--muted)">首轮平台：Facebook · Instagram · LinkedIn（人工工作流·官方API未接入）｜YouTube 列为后续候选</div>' +
      '    </div>' +
      '    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
      '      <select id="v3ContextSelect" aria-label="切换数据空间" style="min-height:34px;padding:3px 8px;border:1px solid var(--line);border-radius:8px;background:var(--surface2);color:var(--ink);font-size:12px;max-width:100%"></select>' +
      '      <button type="button" class="pill" id="v3BtnClose" style="min-height:34px;padding:3px 10px">✕ 关闭</button>' +
      '    </div>' +
      '  </div>' +
      '  <div id="v3ToastBar" class="v2-guard-bar lv-green" hidden style="margin:0"></div>' +
      '  <div id="v3ContextBanner" class="v2-guard-bar lv-yellow" style="margin:0;font-size:12px"></div>' +
      '  <div class="v3-tabs" id="v3TabBar" role="tablist">' +
      '    <button type="button" class="pill primary" data-v3tab="todos">📋 今日行动与微信卡</button>' +
      '    <button type="button" class="pill" data-v3tab="tasks">🎯 发现任务 (FB/IG/LI)</button>' +
      '    <button type="button" class="pill" data-v3tab="signals">🔎 候选登记 / 审核 / 草稿</button>' +
      '    <button type="button" class="pill" data-v3tab="compare">📊 来源效果对比</button>' +
      '    <button type="button" class="pill" data-v3tab="projects">🏗️ 项目角色与报备</button>' +
      '    <button type="button" class="pill" data-v3tab="admin">⚙️ 入驻 / 目录 / 空间授权</button>' +
      '  </div>' +
      '  <div id="v3Body" class="v3-body"></div>' +
      '</div>';
    document.body.appendChild(modalEl);

    modalEl.querySelector("#v3BtnClose").addEventListener("click", closeHub);
    modalEl.addEventListener("click", function (ev) {
      if (ev.target === modalEl) closeHub();
    });

    modalEl.querySelector("#v3ContextSelect").addEventListener("change", function (ev) {
      var val = ev.target.value;
      var st = global.FG_V3.getState();
      var chosen = st.contexts.find(function (c) { return (c.org_id + "::" + c.membership_id) === val; });
      if (!chosen) {
        var grant = st.supportGrants.find(function (g) { return ("grant::" + g.org_id) === val; });
        if (grant) {
          chosen = { org_id: grant.org_id, org_type: grant.org_type, org_name: grant.org_name + " (只读排障)", role: "support_readonly", membership_id: "support_grant" };
        }
      }
      global.FG_V3.switchContext(chosen || null);
      renderCurrentTab();
    });

    modalEl.querySelectorAll("[data-v3tab]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        setTab(btn.getAttribute("data-v3tab"));
      });
    });

    return modalEl;
  }

  function setTab(tab) {
    activeTab = tab || "todos";
    if (modalEl) {
      modalEl.querySelectorAll("[data-v3tab]").forEach(function (b) {
        b.classList.toggle("primary", b.getAttribute("data-v3tab") === activeTab);
      });
    }
    renderCurrentTab();
  }

  function renderContextBar() {
    if (!modalEl || !global.FG_V3) return;
    var st = global.FG_V3.getState();
    var sel = modalEl.querySelector("#v3ContextSelect");
    var banner = modalEl.querySelector("#v3ContextBanner");

    var opts = '<option value="">-- 请选择数据空间上下文 --</option>';
    st.contexts.forEach(function (c) {
      var k = c.org_id + "::" + c.membership_id;
      var selected = st.activeContext && st.activeContext.org_id === c.org_id && st.activeContext.membership_id === c.membership_id ? " selected" : "";
      opts += '<option value="' + esc(k) + '"' + selected + '>' + esc(c.org_name) + ' [' + esc(c.role) + ']</option>';
    });
    st.supportGrants.forEach(function (g) {
      var k = "grant::" + g.org_id;
      var selected = st.activeContext && st.activeContext.org_id === g.org_id && st.activeContext.role === "support_readonly" ? " selected" : "";
      opts += '<option value="' + esc(k) + '"' + selected + '>🔒 只读排障授权: ' + esc(g.org_name) + '</option>';
    });
    sel.innerHTML = opts;

    if (!st.activeContext) {
      banner.className = "v2-guard-bar lv-yellow";
      banner.textContent = "⚠️ 尚未选择数据空间上下文（REV01 强制显式上下文，严禁自动回落主空间）。请在右上角下拉框中选择您的工作空间。";
    } else {
      banner.className = st.activeContext.role === "support_readonly" ? "v2-guard-bar lv-yellow" : "v2-guard-bar lv-green";
      banner.innerHTML =
        "<b>当前空间：</b>" + esc(st.activeContext.org_name) +
        " · <b>类型：</b>" + esc(st.activeContext.org_type) +
        " · <b>角色：</b>" + esc(st.activeContext.role) +
        " · <b>隔离纪元：</b>#" + st.contextEpoch +
        (st.activeContext.partner_ref_code
          ? (' · <b>专属推荐码：</b><code>' + esc(st.activeContext.partner_ref_code) + '</code> <button type="button" class="pill" id="v3CopyRefLinkBtn" style="min-height:24px;padding:1px 8px;font-size:11px">复制推荐询价链接</button>')
          : "");
      var copyRef = banner.querySelector("#v3CopyRefLinkBtn");
      if (copyRef) {
        copyRef.addEventListener("click", function () {
          var base = location.href.split("#")[0].replace(/[^/]*$/, "");
          copyText(base + "rfq.html?ref=" + encodeURIComponent(st.activeContext.partner_ref_code), "已复制专属买方询价推荐链接（仅记录待核实触点）");
        });
      }
    }
  }

  async function renderCurrentTab() {
    if (!modalEl || !global.FG_V3) return;
    renderContextBar();
    var body = modalEl.querySelector("#v3Body");
    var st = global.FG_V3.getState();
    var cloudSt = global.FG_CLOUD && global.FG_CLOUD.getState();
    if (!cloudSt || !cloudSt.loggedIn) {
      body.innerHTML = '<div class="v3-card"><b>需要成员登录</b><p class="muted">请先点击顶部「🔒 成员登录」认证身份后再进入 V3 获客与伙伴协作中心。</p></div>';
      return;
    }
    if (!st.activeContext) {
      body.innerHTML = '<div class="v3-card"><b>请选择数据空间</b><p class="muted">检测到您拥有多个组织角色或尚未选择上下文，请先在右上角下拉框中选择目标数据空间。</p></div>';
      return;
    }

    var epochAtStart = st.contextEpoch;
    body.innerHTML = '<p class="muted">正在从当前隔离空间加载数据…</p>';

    if (activeTab === "todos") await renderTodosTab(body, epochAtStart);
    else if (activeTab === "tasks") await renderTasksTab(body, epochAtStart);
    else if (activeTab === "signals") await renderSignalsTab(body, epochAtStart);
    else if (activeTab === "compare") await renderCompareTab(body, epochAtStart);
    else if (activeTab === "projects") await renderProjectsTab(body, epochAtStart);
    else if (activeTab === "admin") await renderAdminTab(body, epochAtStart);
  }

  // =========================================================================
  // TAB 1: Today's Action Queue + Supervisor Dispatch/Quote + Personal WeChat Card
  // =========================================================================
  async function renderTodosTab(body, epoch) {
    var st = global.FG_V3.getState();
    var isMgr = st.activeContext.role === "super_admin" || st.activeContext.role === "manager";
    var res = await global.FG_V3.listTodos(isMgr ? "all" : "");
    if (res.staleContext || epoch !== global.FG_V3.getContextEpoch()) return;
    if (!res.ok) {
      body.innerHTML = '<div class="v2-guard-bar lv-red">' + esc(res.error || "加载待办失败") + '</div>';
      return;
    }

    var allTodos = res.todos || [];
    var buckets = [
      { key: "all", label: "全部待办" },
      { key: "pending_accept_or_dispatch", label: "待派单 / 待接单" },
      { key: "to_first_contact", label: "待首次联系" },
      { key: "waiting_buyer_reply", label: "等待买方回复" },
      { key: "need_specs", label: "待补规格" },
      { key: "waiting_internal_quote", label: "等待内部报价" },
    ];
    var counts = { all: allTodos.length };
    allTodos.forEach(function (t) {
      counts[t.action_bucket] = (counts[t.action_bucket] || 0) + 1;
    });

    var filtered = todoBucketFilter === "all"
      ? allTodos
      : allTodos.filter(function (t) { return t.action_bucket === todoBucketFilter; });

    var html = '<div class="v3-chips">';
    buckets.forEach(function (b) {
      var cls = todoBucketFilter === b.key ? "v3-chip active" : "v3-chip";
      html += '<button type="button" class="' + cls + '" data-todo-bucket="' + b.key + '">' + b.label + ' (' + (counts[b.key] || 0) + ')</button>';
    });
    html += '</div>';

    if (res.assignmentEventStats && res.assignmentEventStats.length) {
      html += '<div style="font-size:12px;color:var(--muted);margin-bottom:8px">派单历史统计 (ENG06 全留痕)：' +
        res.assignmentEventStats.map(function (e) { return esc(e.event_type) + "=" + Number(e.cnt || 0); }).join(" · ") +
        '</div>';
    }

    if (!filtered.length) {
      html += '<div class="v3-card"><b>当前分组暂无行动项</b><p class="muted">在「候选登记 / 审核」核实需求或收到买方 RFQ 后，待办卡片会自动进入这里。</p></div>';
    } else {
      filtered.forEach(function (t) {
        var readinessBadge = t.fulfillment_readiness === "direct_supply"
          ? '<span class="v3-badge ok">可直接处理</span>'
          : t.fulfillment_readiness === "intelligence_only"
          ? '<span class="v3-badge">暂仅情报</span>'
          : '<span class="v3-badge warn">需技术/供应确认</span>';
        html +=
          '<div class="v3-card">' +
          '  <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center">' +
          '    <b>' + esc(t.inquiry_no || t.project_title || t.id) + ' · ' + esc(t.sig_country || "国家待核实") + ' / ' + esc(t.sig_product || "品类待确认") + '</b>' +
          '    <div style="display:flex;gap:5px;flex-wrap:wrap">' +
          readinessBadge +
          '      <span class="v3-badge">' + esc(t.assignment_status) + '</span>' +
          '    </div>' +
          '  </div>' +
          '  <div style="font-size:13px;margin:6px 0">' + esc(t.demand_summary || "—") + '</div>' +
          '  <div style="font-size:12px;color:var(--muted)">来源：' + esc(t.source_platform || "-") + ' (' + esc(t.acquisition_mode || "-") + ') · 负责人：' + esc(t.primary_assignee_id || "未指派") + ' · 时区：' + esc(t.sla_timezone || "Asia/Singapore") + '</div>' +
          '  <div style="font-size:12px;color:var(--muted)">联系结果：' + esc(t.contact_result || "-") + ' · 草稿：' + Number(t.draft_count || 0) + ' / 复制：' + Number(t.copy_count || 0) + ' / <b>人工实发：' + Number(t.manual_sent_count || 0) + '</b></div>' +
          '  <div class="v3-acts">' +
          (isMgr && ["pending_dispatch", "rejected", "reclaimed"].indexOf(t.assignment_status) >= 0
            ? '<button type="button" class="pill primary" data-act-dispatch="' + esc(t.id) + '">📤 派单给成员</button>'
            : "") +
          (isMgr && ["pending_accept", "accepted"].indexOf(t.assignment_status) >= 0
            ? '<button type="button" class="pill" data-act-reassign="' + esc(t.id) + '">🔄 主管转派</button>'
            : "") +
          (t.assignment_status === "pending_accept"
            ? '<button type="button" class="pill primary" data-act-accept="' + esc(t.id) + '" data-ver="' + Number(t.version || 1) + '">✅ 确认接单</button>' +
              '<button type="button" class="pill" data-act-reject="' + esc(t.id) + '">↩️ 拒单填因</button>'
            : "") +
          (t.inquiry_id && t.inquiry_status !== "quoted" && st.activeContext.role !== "partner_referrer" && st.activeContext.role !== "partner_followup"
            ? '<button type="button" class="pill" data-act-quote="' + esc(t.inquiry_id) + '">💰 关联正式报价</button>'
            : "") +
          '    <button type="button" class="pill" data-copy-wx="' + esc(t.id) + '">💬 复制微信脱敏卡</button>' +
          '    <button type="button" class="pill" data-preview-wx="' + esc(t.id) + '">👁️ 预览微信卡</button>' +
          '  </div>' +
          '  <div id="v3WxPre_' + esc(t.id) + '" class="v3-wx-pre" hidden>' + esc(t.wechatSafeCard) + '</div>' +
          '</div>';
      });
    }
    body.innerHTML = html;

    body.querySelectorAll("[data-todo-bucket]").forEach(function (b) {
      b.addEventListener("click", function () {
        todoBucketFilter = b.getAttribute("data-todo-bucket");
        renderCurrentTab();
      });
    });

    body.querySelectorAll("[data-act-dispatch]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var asgId = btn.getAttribute("data-act-dispatch");
        var assignee = prompt("请输入接单人 employee_id（当前空间有效成员）：", (global.FG_CLOUD.getState().employee || {}).id || "");
        if (!assignee) return;
        var tz = prompt("请输入接单人工作时区（用于期限提醒）：", "Asia/Singapore") || "Asia/Singapore";
        var r = await global.FG_V3.assignDispatch({ assignment_id: asgId, assignee_employee_id: assignee.trim(), sla_timezone: tz.trim() }, "dsp_" + asgId + "_" + Date.now());
        toast(r.ok ? "派单成功（待接单人确认）" : ("派单失败：" + (r.error || r.code)));
        renderCurrentTab();
      });
    });

    body.querySelectorAll("[data-act-reassign]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var asgId = btn.getAttribute("data-act-reassign");
        var toEmp = prompt("请输入新接单人 employee_id：", "");
        if (!toEmp) return;
        var reason = prompt("请输入转派原因（写入不可变事件历史）：", "业务负载与语种调配") || "supervisor_reassigned";
        var r = await global.FG_V3.reassignDispatch(asgId, { to_assignee_id: toEmp.trim(), reason: reason });
        toast(r.ok ? "转派完成，历史已留痕" : ("转派失败：" + (r.error || r.code)));
        renderCurrentTab();
      });
    });

    body.querySelectorAll("[data-act-accept]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var id = btn.getAttribute("data-act-accept");
        var ver = Number(btn.getAttribute("data-ver") || 1);
        var r = await global.FG_V3.acceptDispatch(id, { version: ver }, "acc_" + id + "_" + ver);
        toast(r.ok ? "接单成功（DB.batch 原子写入事件）" : ("接单失败：" + (r.error || r.code)));
        renderCurrentTab();
      });
    });

    body.querySelectorAll("[data-act-reject]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var id = btn.getAttribute("data-act-reject");
        var reason = prompt("请输入拒单原因（便于主管快速改派）：", "暂不覆盖该语言或产品方向");
        if (!reason) return;
        var r = await global.FG_V3.rejectDispatch(id, { reason: reason });
        toast(r.ok ? "已退回待派单队列" : ("操作失败：" + (r.error || r.code)));
        renderCurrentTab();
      });
    });

    body.querySelectorAll("[data-act-quote]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var inqId = btn.getAttribute("data-act-quote");
        var refNo = prompt("请输入正式报价单号（可留空自动生成）：", "");
        var amtMajor = prompt("请输入对外报价总额（USD，如 48500.00，不含内部成本与毛利）：", "10000.00");
        if (!amtMajor) return;
        var minor = Math.round(Number(amtMajor) * 100) || 0;
        var r = await global.FG_V3.createInquiryQuote(inqId, { ref_no: refNo || undefined, currency: "USD", total_minor: minor, incoterm: "FOB" });
        toast(r.ok ? ("正式报价已关联：" + r.ref_no) : ("关联失败：" + (r.error || r.code)));
        renderCurrentTab();
      });
    });

    body.querySelectorAll("[data-copy-wx]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-copy-wx");
        var item = allTodos.find(function (x) { return x.id === id; });
        if (item) copyText(item.wechatSafeCard, "已复制个人微信脱敏提醒卡（不含电话/邮箱/报价/凭证）");
      });
    });

    body.querySelectorAll("[data-preview-wx]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var el = body.querySelector("#v3WxPre_" + btn.getAttribute("data-preview-wx"));
        if (el) el.hidden = !el.hidden;
      });
    });
  }

  // =========================================================================
  // TAB 2: Discovery Tasks & 3-Platform Status Strip (ACQ01-03)
  // =========================================================================
  async function renderTasksTab(body, epoch) {
    var res = await global.FG_V3.listTasks();
    if (res.staleContext || epoch !== global.FG_V3.getContextEpoch()) return;
    var tasks = (res.ok && res.tasks) || [];
    var st = global.FG_V3.getState();
    var isPartner = st.activeContext.role === "partner_followup" || st.activeContext.role === "partner_referrer";

    var html =
      '<div class="v3-plat-strip">' +
      '  <div class="v3-plat-box"><b>Facebook · 首轮</b><br><span class="v3-badge ok">每日人工在用</span><br>官方API：<b>待授权/未接入</b></div>' +
      '  <div class="v3-plat-box"><b>Instagram · 首轮</b><br><span class="v3-badge ok">每日人工在用</span><br>官方API：<b>待授权/未接入</b></div>' +
      '  <div class="v3-plat-box"><b>LinkedIn · 首轮</b><br><span class="v3-badge ok">每日人工在用</span><br>Lead Sync：<b>待授权/未接入</b></div>' +
      '  <div class="v3-plat-box is-future"><b>YouTube · 后续候选</b><br><span class="v3-badge">已有资源保留</span><br>不计入首轮完成率</div>' +
      '</div>';

    if (!isPartner) {
      html +=
        '<div class="v3-card">' +
        '  <b>新建社媒需求发现任务（首轮默认不限国家 ANY、不强限四大品类）</b>' +
        '  <div class="v3-grid" style="margin-top:8px">' +
        '    <div class="v3-field"><label>平台</label><select id="v3TaskPlat"><option value="facebook">Facebook (首轮)</option><option value="instagram">Instagram (首轮)</option><option value="linkedin">LinkedIn (首轮)</option><option value="youtube">YouTube (后续候选·不计入首轮)</option></select></div>' +
        '    <div class="v3-field"><label>获客方式（严格分列统计）</label><select id="v3TaskMode"><option value="manual_discovery">manual_discovery · 主动人工发现</option><option value="owned_account_inquiry">owned_account_inquiry · 自有账号主动咨询</option><option value="owned_ad_form">owned_ad_form · 自有广告表单</option></select></div>' +
        '    <div class="v3-field"><label>任务名称 *</label><input id="v3TaskTitle" placeholder="如：FB 工业采购群 W1 来源对比"></div>' +
        '    <div class="v3-field"><label>国家范围（默认 ANY 不限）</label><input id="v3TaskCountry" value="ANY"></div>' +
        '    <div class="v3-field"><label>产品关键词（选填）</label><input id="v3TaskProd" placeholder="如：valve, HDPE pipe, cable, steel 或留空"></div>' +
        '    <div class="v3-field"><label>采购意图词（仅检索起点）</label><input id="v3TaskIntent" value="looking for supplier, RFQ, need distributor"></div>' +
        '    <div class="v3-field"><label>排除词（过滤卖货广告/招聘）</label><input id="v3TaskExcl" value="we supply, factory direct, wholesale, hiring"></div>' +
        '    <div class="v3-field"><label>实际费用（USD，无支出请留空勿填0）</label><input id="v3TaskSpend" type="number" step="0.01" placeholder="留空表示未知/未记录"></div>' +
        '  </div>' +
        '  <div class="v3-acts"><button type="button" class="pill primary" id="v3BtnCreateTask">＋ 创建发现任务</button></div>' +
        '</div>';
    }

    if (!tasks.length) {
      html += '<div class="v3-card"><p class="muted" style="margin:0">暂无发现任务，请先创建首轮 FB / IG / LI 对比任务。</p></div>';
    } else {
      tasks.forEach(function (t) {
        var hrs = (Number(t.hours_logged_tenths || 0) / 10).toFixed(1);
        var spendTxt = t.actual_spend_minor === null || t.actual_spend_minor === undefined
          ? "未知（未记录费用）"
          : ((Number(t.actual_spend_minor) / 100).toFixed(2) + " " + (t.spend_currency || "USD"));
        html +=
          '<div class="v3-card">' +
          '  <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">' +
          '    <b>[' + esc(t.platform.toUpperCase()) + ' · ' + esc(t.acquisition_mode) + '] ' + esc(t.title) + '</b>' +
          '    <span class="v3-badge">' + esc(t.status) + '</span>' +
          '  </div>' +
          '  <div style="font-size:12px;color:var(--muted);margin-top:4px">国家范围：' + esc(t.country_scope) + ' · 累计工时：<b>' + hrs + 'h</b> · 实际支出：' + esc(spendTxt) + ' · 复盘窗：' + Number(t.review_window_days || 14) + ' 天</div>' +
          (!isPartner
            ? '  <div class="v3-acts">' +
              '    <button type="button" class="pill" data-add-hr="' + esc(t.id) + '" data-tenths="5">⏱️ +0.5h 工时</button>' +
              '    <button type="button" class="pill" data-add-hr="' + esc(t.id) + '" data-tenths="10">⏱️ +1.0h 工时</button>' +
              '    <button type="button" class="pill" data-toggle-task="' + esc(t.id) + '" data-next-st="' + (t.status === "active" ? "paused" : "active") + '">' + (t.status === "active" ? "⏸️ 暂停" : "▶️ 恢复") + '</button>' +
              '  </div>'
            : "") +
          '</div>';
      });
    }
    body.innerHTML = html;

    var btnCreate = body.querySelector("#v3BtnCreateTask");
    if (btnCreate) {
      btnCreate.addEventListener("click", async function () {
        var rawSpend = body.querySelector("#v3TaskSpend").value.trim();
        var spendMinor = rawSpend !== "" && Number.isFinite(Number(rawSpend)) ? Math.round(Number(rawSpend) * 100) : null;
        var r = await global.FG_V3.createTask({
          platform: body.querySelector("#v3TaskPlat").value,
          acquisition_mode: body.querySelector("#v3TaskMode").value,
          title: body.querySelector("#v3TaskTitle").value.trim(),
          country_scope: body.querySelector("#v3TaskCountry").value.trim() || "ANY",
          product_keywords: body.querySelector("#v3TaskProd").value.trim(),
          intent_keywords: body.querySelector("#v3TaskIntent").value.trim(),
          exclude_keywords: body.querySelector("#v3TaskExcl").value.trim(),
          actual_spend_minor: spendMinor,
          spend_currency: spendMinor !== null ? "USD" : "",
        });
        toast(r.ok ? "发现任务已创建" : ("创建失败：" + (r.error || r.code)));
        if (r.ok) renderCurrentTab();
      });
    }
    body.querySelectorAll("[data-add-hr]").forEach(function (b) {
      b.addEventListener("click", async function () {
        var tenths = Number(b.getAttribute("data-tenths") || 5);
        var r = await global.FG_V3.patchTask(b.getAttribute("data-add-hr"), { add_hours_tenths: tenths });
        toast(r.ok ? ("已累加 " + (tenths / 10).toFixed(1) + "h 人工工时") : ("更新失败：" + (r.error || r.code)));
        if (r.ok) renderCurrentTab();
      });
    });
    body.querySelectorAll("[data-toggle-task]").forEach(function (b) {
      b.addEventListener("click", async function () {
        var r = await global.FG_V3.patchTask(b.getAttribute("data-toggle-task"), { status: b.getAttribute("data-next-st") });
        toast(r.ok ? "任务状态已更新" : ("更新失败：" + r.error));
        if (r.ok) renderCurrentTab();
      });
    });
  }

  // =========================================================================
  // TAB 3: Candidate Signals, Explainable Triage, Audit & Draft vs Manual Send (ACQ04-09)
  // =========================================================================
  async function renderSignalsTab(body, epoch) {
    var qsParts = [];
    if (sigFilters.platform) qsParts.push("platform=" + encodeURIComponent(sigFilters.platform));
    if (sigFilters.audit_status) qsParts.push("audit_status=" + encodeURIComponent(sigFilters.audit_status));
    if (sigFilters.contact_result) qsParts.push("contact_result=" + encodeURIComponent(sigFilters.contact_result));

    var [sigRes, taskRes] = await Promise.all([
      global.FG_V3.listSignals(qsParts.join("&")),
      global.FG_V3.listTasks(),
    ]);
    if (sigRes.staleContext || epoch !== global.FG_V3.getContextEpoch()) return;
    var signals = (sigRes.ok && sigRes.signals) || [];
    var tasks = (taskRes.ok && taskRes.tasks) || [];
    var savedDraft = global.FG_V3.loadScopedDraft("signal") || {};
    var hasDraft = Boolean(savedDraft.demand_summary || savedDraft.country_en || savedDraft.source_url);
    var st = global.FG_V3.getState();
    var isPartner = st.activeContext.role === "partner_followup" || st.activeContext.role === "partner_referrer";

    var taskOpts = '<option value="">（不绑定或单独登记）</option>' + tasks.map(function (t) {
      return '<option value="' + esc(t.id) + '">[' + esc(t.platform.toUpperCase()) + '] ' + esc(t.title) + '</option>';
    }).join("");

    var html =
      '<div class="v3-card">' +
      '  <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center">' +
      '    <b>登记社媒候选需求信号（发布时间未知请留空，严禁编造）</b>' +
      '    <span class="v3-badge ' + (hasDraft ? "warn" : "") + '">' + (hasDraft ? "已加载当前账号/空间隔离草稿" : "草稿按账号+空间自动隔离") + '</span>' +
      '  </div>' +
      '  <div class="v3-grid" style="margin-top:8px">' +
      '    <div class="v3-field"><label>来源平台</label><select id="v3SigPlat"><option value="facebook">Facebook</option><option value="instagram">Instagram</option><option value="linkedin">LinkedIn</option><option value="youtube">YouTube (后续候选)</option><option value="website">Website</option></select></div>' +
      '    <div class="v3-field"><label>获客方式</label><select id="v3SigMode"><option value="manual_discovery">manual_discovery · 主动人工发现</option><option value="owned_account_inquiry">owned_account_inquiry · 自有账号咨询</option><option value="owned_ad_form">owned_ad_form · 自有广告表单</option></select></div>' +
      '    <div class="v3-field"><label>关联发现任务（选填）</label><select id="v3SigTask">' + taskOpts + '</select></div>' +
      '    <div class="v3-field"><label>信号分层 (REV11)</label><select id="v3SigTier"><option value="potential_demand">potential_demand · 潜在采购讨论</option><option value="verified_opportunity">verified_opportunity · 明确采购机会</option><option value="direct_inquiry">direct_inquiry · 直接咨询</option><option value="market_event">market_event · 市场/工程事件</option></select></div>' +
      '    <div class="v3-field"><label>国家（选填，未知留空）</label><input id="v3SigCountry" value="' + esc(savedDraft.country_en || "") + '" placeholder="如：UAE / Vietnam / 留空"></div>' +
      '    <div class="v3-field"><label>产品方向（选填，不限品类）</label><input id="v3SigProd" value="' + esc(savedDraft.product_line || "") + '" placeholder="如：pe_pipes / valves / cables / 其他"></div>' +
      '    <div class="v3-field"><label>买家角色</label><select id="v3SigRole"><option value="unknown">unknown · 待核实</option><option value="epc">EPC 总包</option><option value="importer">进口商</option><option value="distributor">经销商</option><option value="owner">业主</option><option value="subcontractor">分包商</option><option value="buyer">采购方</option></select></div>' +
      '    <div class="v3-field"><label>原始链接 / 来源标识（选填）</label><input id="v3SigUrl" value="' + esc(savedDraft.source_url || "") + '" placeholder="仅记录允许留存的来源链接或帖子 ID"></div>' +
      '    <div class="v3-field" style="grid-column:1/-1"><label>需求摘要与证据 *</label><textarea id="v3SigSummary" placeholder="简要记录买方真实采购表述、规格与语境（勿整段复制无关群聊）">' + esc(savedDraft.demand_summary || "") + '</textarea></div>' +
      '  </div>' +
      '  <div class="v3-acts"><button type="button" class="pill primary" id="v3BtnCreateSig">＋ 登记候选信号</button><button type="button" class="pill" id="v3BtnClearSigDraft">清空草稿</button></div>' +
      '</div>' +
      '<div class="v3-filter-bar">' +
      '  <b style="font-size:12px">筛选：</b>' +
      '  <select id="v3FltPlat"><option value="">全部平台</option><option value="facebook">Facebook</option><option value="instagram">Instagram</option><option value="linkedin">LinkedIn</option><option value="youtube">YouTube</option><option value="website">Website</option></select>' +
      '  <select id="v3FltAudit"><option value="">全部审核状态</option><option value="pending_verify">pending_verify · 待核实</option><option value="verified_valid">verified_valid · 已核实有效</option><option value="seller_ad">seller_ad · 同行广告</option><option value="expired">expired · 已过期</option><option value="duplicate">duplicate · 重复</option><option value="irrelevant">irrelevant · 无关</option></select>' +
      '  <select id="v3FltContact"><option value="">全部联系结果</option><option value="to_contact">to_contact · 待联系</option><option value="manual_sent">manual_sent · 已人工实发</option><option value="active_dialogue">active_dialogue · 有有效回复</option><option value="need_specs">need_specs · 待补规格</option><option value="converted_inquiry">converted_inquiry · 已转询盘</option><option value="opted_out">opted_out · 已拒绝联系</option></select>' +
      '  <span style="font-size:12px;color:var(--muted);margin-left:auto">共 ' + signals.length + ' 条</span>' +
      '</div>';

    signals.forEach(function (s) {
      var reasons = (s.judgment_tags && s.judgment_tags.reasons) || [];
      var nextQs = (s.judgment_tags && s.judgment_tags.nextQuestions) || [];
      var auditCls = (s.audit_status === "verified_valid" || s.audit_status === "approved") ? "ok" : (s.audit_status === "pending_verify" ? "warn" : "");
      var contactCls = s.contact_result === "opted_out" ? "err" : (s.contact_result === "active_dialogue" || s.contact_result === "converted_inquiry" ? "ok" : "");
      html +=
        '<div class="v3-card">' +
        '  <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center">' +
        '    <b>[' + esc(s.source_platform.toUpperCase()) + ' · ' + esc(s.acquisition_mode) + '] ' + esc(s.country_en || "国家未知") + ' / ' + esc(s.product_line || "品类待确认") + '</b>' +
        '    <div style="display:flex;gap:5px;flex-wrap:wrap">' +
        '      <span class="v3-badge ' + auditCls + '">审核:' + esc(s.audit_status) + '</span>' +
        '      <span class="v3-badge ' + contactCls + '">联系:' + esc(s.contact_result) + '</span>' +
        '    </div>' +
        '  </div>' +
        '  <div style="font-size:13px;margin:5px 0">' + esc(s.demand_summary) + '</div>' +
        '  <div style="font-size:12px;color:var(--muted)">发布时间：' + esc(s.published_at || "未知 (NULL)") + ' · 买家角色：' + esc(s.buyer_role) + ' · 供货判断：' + esc(s.fulfillment_readiness) + '</div>' +
        '  <div style="font-size:12px;color:var(--muted)">可解释判断：' + esc(reasons.join("；") || "待人工核实") + ' ｜ 缺失项：' + esc((s.missing_info || []).join(", ") || "无") + '</div>' +
        (nextQs.length ? ('<div style="font-size:12px;color:var(--brown)">建议首轮澄清：' + esc(nextQs.join(" / ")) + '</div>') : "") +
        '  <div style="font-size:12px;color:var(--muted);margin-top:3px">草稿：' + Number(s.draft_count || 0) + ' ｜ 复制：' + Number(s.copy_count || 0) + '（不计触达） ｜ <b>人工实发：' + Number(s.manual_sent_count || 0) + '</b></div>' +
        '  <div class="v3-acts">' +
        (!isPartner && s.audit_status === "pending_verify"
          ? '<button type="button" class="pill primary" data-audit-act="verified_valid|dev_lead" data-sid="' + esc(s.id) + '">✅ 核实有效→建开发单</button>' +
            '<button type="button" class="pill" data-audit-act="verified_valid|valid_inquiry" data-sid="' + esc(s.id) + '">📄 核实有效→直转询盘</button>' +
            '<button type="button" class="pill" data-audit-act="seller_ad|" data-sid="' + esc(s.id) + '">🚫 同行广告</button>' +
            '<button type="button" class="pill" data-audit-act="expired|" data-sid="' + esc(s.id) + '">⏰ 过期</button>' +
            '<button type="button" class="pill" data-audit-act="irrelevant|" data-sid="' + esc(s.id) + '">🗑️ 无关</button>'
          : "") +
        '    <button type="button" class="pill" data-gen-draft="' + esc(s.id) + '">✍️ 生成可编辑草稿</button>' +
        '    <button type="button" class="pill" data-sig-action="manual_sent" data-sid="' + esc(s.id) + '">📨 确认已人工发送</button>' +
        '    <button type="button" class="pill" data-sig-action="replied" data-sid="' + esc(s.id) + '">💬 登记买方回复</button>' +
        '    <button type="button" class="pill" data-sig-action="need_specs" data-sid="' + esc(s.id) + '">❓ 待补规格</button>' +
        '    <button type="button" class="pill" data-sig-action="convert_inquiry" data-sid="' + esc(s.id) + '">📄 转为正式询盘</button>' +
        '    <button type="button" class="pill" data-sig-action="opted_out" data-sid="' + esc(s.id) + '">⛔ 拒绝联系(退订)</button>' +
        '  </div>' +
        '  <div id="v3DraftBox_' + esc(s.id) + '" class="v3-draft-box" hidden></div>' +
        '</div>';
    });
    body.innerHTML = html;

    // Bind filter values & listeners
    var fPlat = body.querySelector("#v3FltPlat");
    var fAud = body.querySelector("#v3FltAudit");
    var fCon = body.querySelector("#v3FltContact");
    if (fPlat) { fPlat.value = sigFilters.platform; fPlat.addEventListener("change", function () { sigFilters.platform = fPlat.value; renderCurrentTab(); }); }
    if (fAud) { fAud.value = sigFilters.audit_status; fAud.addEventListener("change", function () { sigFilters.audit_status = fAud.value; renderCurrentTab(); }); }
    if (fCon) { fCon.value = sigFilters.contact_result; fCon.addEventListener("change", function () { sigFilters.contact_result = fCon.value; renderCurrentTab(); }); }

    function persistDraft() {
      global.FG_V3.saveScopedDraft("signal", {
        country_en: body.querySelector("#v3SigCountry").value,
        product_line: body.querySelector("#v3SigProd").value,
        source_url: body.querySelector("#v3SigUrl").value,
        demand_summary: body.querySelector("#v3SigSummary").value,
      });
    }
    ["#v3SigCountry", "#v3SigProd", "#v3SigUrl", "#v3SigSummary"].forEach(function (sel) {
      var el = body.querySelector(sel);
      if (el) el.addEventListener("input", persistDraft);
    });

    body.querySelector("#v3BtnClearSigDraft").addEventListener("click", function () {
      global.FG_V3.clearScopedDraft("signal");
      renderCurrentTab();
    });

    body.querySelector("#v3BtnCreateSig").addEventListener("click", async function () {
      var r = await global.FG_V3.createSignal({
        task_id: body.querySelector("#v3SigTask").value,
        source_platform: body.querySelector("#v3SigPlat").value,
        acquisition_mode: body.querySelector("#v3SigMode").value,
        signal_tier: body.querySelector("#v3SigTier").value,
        country_en: body.querySelector("#v3SigCountry").value.trim(),
        product_line: body.querySelector("#v3SigProd").value.trim(),
        buyer_role: body.querySelector("#v3SigRole").value,
        source_url: body.querySelector("#v3SigUrl").value.trim(),
        demand_summary: body.querySelector("#v3SigSummary").value.trim(),
      });
      if (r.ok) {
        global.FG_V3.clearScopedDraft("signal");
        toast("候选信号已登记（已生成可解释判断与缺失项清单）");
        renderCurrentTab();
      } else {
        toast("登记失败（隔离草稿已保留）：" + (r.error || r.code));
      }
    });

    body.querySelectorAll("[data-audit-act]").forEach(function (b) {
      b.addEventListener("click", async function () {
        var parts = b.getAttribute("data-audit-act").split("|");
        var r = await global.FG_V3.auditSignal(b.getAttribute("data-sid"), {
          audit_status: parts[0],
          promote_to: parts[1] || "",
          audit_reason: "人工核实:" + parts[0],
        });
        toast(r.ok ? (r.duplicateDispatchPrevented ? "已核实（同需求已存在有效派单，未重复派发）" : "审核状态已更新") : ("失败：" + (r.error || r.code)));
        renderCurrentTab();
      });
    });

    body.querySelectorAll("[data-gen-draft]").forEach(function (b) {
      b.addEventListener("click", async function () {
        var sid = b.getAttribute("data-gen-draft");
        var r = await global.FG_V3.generateDraft(sid, { lang: "en" });
        var box = body.querySelector("#v3DraftBox_" + sid);
        if (!box) return;
        if (!r.ok) { toast("草稿生成失败：" + (r.error || r.code)); return; }
        box.innerHTML =
          '<div style="font-size:12px;margin-bottom:6px">' +
          (r.optOutBlocked ? '<b style="color:var(--danger)">⛔ 退订/阻断预警：严禁主动联系该对象！</b>' : '<b>可编辑回复草稿</b> · ' + (r.approvedCatalogUsed ? '<span class="v3-badge ok">已引用核验目录事实</span>' : '<span class="v3-badge">未匹配已核验目录，仅用保守标准话术</span>')) +
          (r.alreadyFollowedBy ? (' · <span class="v3-badge warn">已有跟进人：' + esc(r.alreadyFollowedBy) + '</span>') : "") +
          '</div>' +
          '<textarea id="v3DraftTa_' + esc(sid) + '">' + esc(r.draftText) + '</textarea>' +
          '<div style="font-size:11.5px;color:var(--muted);margin-top:4px">' + esc(r.notice) + '</div>' +
          '<div class="v3-acts">' +
          '  <button type="button" class="pill" data-copy-draft="' + esc(sid) + '">📋 复制草稿（仅记辅助·不计触达）</button>' +
          '  <button type="button" class="pill primary" data-sent-after-draft="' + esc(sid) + '">📨 我已在原平台人工发出</button>' +
          '</div>';
        box.hidden = false;
        box.querySelector("[data-copy-draft]").addEventListener("click", async function () {
          var ta = box.querySelector("#v3DraftTa_" + sid);
          copyText(ta ? ta.value : r.draftText, "草稿已复制（仅记录 copy_count，严格不计入人工触达）");
          await global.FG_V3.logContactAction(sid, { action: "copied" });
        });
        box.querySelector("[data-sent-after-draft]").addEventListener("click", async function () {
          var sr = await global.FG_V3.logContactAction(sid, { action: "manual_sent" });
          toast(sr.ok ? "已登记人工实际发送" : ("拦截：" + (sr.error || sr.code)));
          renderCurrentTab();
        });
      });
    });

    body.querySelectorAll("[data-sig-action]").forEach(function (b) {
      b.addEventListener("click", async function () {
        var act = b.getAttribute("data-sig-action");
        var sid = b.getAttribute("data-sid");
        if (act === "opted_out" && !confirm("确认将该信号（及关联企业）标记为拒绝联系/退订？此状态受单调保护，后续联系将被硬拦截。")) return;
        var r = await global.FG_V3.logContactAction(sid, { action: act });
        toast(r.ok ? ("操作成功：" + act + (r.inquiry_no ? (" (" + r.inquiry_no + ")") : "")) : ("失败/拦截：" + (r.error || r.code)));
        renderCurrentTab();
      });
    });
  }

  // =========================================================================
  // TAB 4: Honest Source Comparison (ACQ10)
  // =========================================================================
  async function renderCompareTab(body, epoch) {
    var qs = [];
    if (cmpFilters.country) qs.push("country=" + encodeURIComponent(cmpFilters.country));
    if (cmpFilters.product_line) qs.push("product_line=" + encodeURIComponent(cmpFilters.product_line));
    var res = await global.FG_V3.getSourceComparison(qs.join("&"));
    if (res.staleContext || epoch !== global.FG_V3.getContextEpoch()) return;
    if (!res.ok) {
      body.innerHTML = '<div class="v2-guard-bar lv-red">' + esc(res.error || "无权查看来源比较") + '</div>';
      return;
    }

    var rows = res.groups || [];
    var futureRows = res.futureCandidates || [];

    var html =
      '<div class="v2-guard-bar lv-yellow" style="margin-bottom:10px">' +
      '  <b>同口径分母约束 (ACQ10)：</b>核实有效率 = 已核实有效 / 已完成核实（待核实单列）；回复率 = 有效回复 / 人工实发（草稿与复制严禁计入）；未记录费用显示「未知」，绝不造假 0 成本；YouTube 不计入首轮汇总。' +
      '</div>' +
      '<div class="v3-filter-bar">' +
      '  <input id="v3CmpCountry" value="' + esc(cmpFilters.country) + '" placeholder="按国家筛选（如 UAE）">' +
      '  <input id="v3CmpProd" value="' + esc(cmpFilters.product_line) + '" placeholder="按品类筛选（如 pe_pipes）">' +
      '  <button type="button" class="pill primary" id="v3BtnRunCmp">刷新对比</button>' +
      '  <button type="button" class="pill" id="v3BtnCopyCmpMd">📋 复制周复盘 Markdown 表</button>' +
      '</div>';

    function renderGroupTable(list, title) {
      if (!list.length) return '<div class="v3-card"><b>' + esc(title) + '</b><p class="muted" style="margin:6px 0 0">暂无样本数据。</p></div>';
      var t = '<div class="v3-card"><b>' + esc(title) + '</b><div class="v3-table-wrap" style="margin-top:8px"><table><thead><tr>' +
        '<th>平台 / 获客方式</th><th>已查候选</th><th>待核实</th><th>核实有效/已核实(率)</th><th>草稿/复制</th><th>人工实发</th><th>有效回复(率)</th><th>询盘/已报价</th><th>工时(h)</th><th>实际费用</th>' +
        '</tr></thead><tbody>';
      list.forEach(function (g) {
        var vRate = g.verified_valid_rate_pct === null ? "—" : (g.verified_valid_rate_pct + "%");
        var rRate = g.reply_rate_pct === null ? "—" : (g.reply_rate_pct + "%");
        var hrs = g.hours_logged_tenths === null ? "未知" : (g.hours_logged_tenths / 10).toFixed(1);
        var spend = g.actual_spend_minor === null ? "未知" : (g.actual_spend_minor / 100).toFixed(2);
        t +=
          '<tr>' +
          '<td><b>' + esc(g.source_platform) + '</b><br><small>' + esc(g.acquisition_mode) + (g.small_sample_warning ? ' · ⚠️小样本(n&lt;20)' : '') + '</small></td>' +
          '<td>' + g.checked_candidates + '</td>' +
          '<td>' + g.pending_verify_count + '</td>' +
          '<td>' + g.verified_valid + '/' + g.verified_completed + ' (' + vRate + ')</td>' +
          '<td>' + g.drafts_generated + ' / ' + g.copies_count + '</td>' +
          '<td><b>' + g.manual_outreach_count + '</b></td>' +
          '<td>' + g.replied_count + ' (' + rRate + ')</td>' +
          '<td>' + g.inquiries_count + ' / ' + g.quoted_count + '</td>' +
          '<td>' + hrs + '</td>' +
          '<td>' + spend + '</td>' +
          '</tr>';
      });
      t += '</tbody></table></div></div>';
      return t;
    }

    html += renderGroupTable(rows, "首轮三平台及官网来源对比（Facebook / Instagram / LinkedIn / Website）");
    if (futureRows.length) {
      html += renderGroupTable(futureRows, "后续候选平台单列（YouTube — 不计入首轮完成率）");
    }
    body.innerHTML = html;

    body.querySelector("#v3BtnRunCmp").addEventListener("click", function () {
      cmpFilters.country = body.querySelector("#v3CmpCountry").value.trim();
      cmpFilters.product_line = body.querySelector("#v3CmpProd").value.trim();
      renderCurrentTab();
    });
    body.querySelector("#v3BtnCopyCmpMd").addEventListener("click", function () {
      var lines = [
        "| 平台 | 获客方式 | 候选 | 待核实 | 核实有效/已核实 | 人工实发 | 有效回复 | 询盘/报价 | 工时(h) | 费用 |",
        "|---|---|---|---|---|---|---|---|---|---|",
      ];
      rows.forEach(function (g) {
        lines.push("| " + [
          g.source_platform,
          g.acquisition_mode,
          g.checked_candidates,
          g.pending_verify_count,
          g.verified_valid + "/" + g.verified_completed,
          g.manual_outreach_count,
          g.replied_count,
          g.inquiries_count + "/" + g.quoted_count,
          g.hours_logged_tenths === null ? "未知" : (g.hours_logged_tenths / 10).toFixed(1),
          g.actual_spend_minor === null ? "未知" : (g.actual_spend_minor / 100).toFixed(2),
        ].join(" | ") + " |");
      });
      copyText(lines.join("\n"), "已复制同口径 Markdown 来源对比表");
    });
  }

  // =========================================================================
  // TAB 5: Lightweight Projects & Buyer Roles + 3-Tier Blind-Dedupe Deal Reg (UX03/UX05/REV07-08)
  // =========================================================================
  async function renderProjectsTab(body, epoch) {
    var st = global.FG_V3.getState();
    var isMgr = st.activeContext.role === "super_admin" || st.activeContext.role === "manager";
    var [pRes, dRes, cRes] = await Promise.all([
      global.FG_V3.listProjects(),
      global.FG_V3.listDealRegs(),
      global.FG_V3.listCompanies(),
    ]);
    if (pRes.staleContext || epoch !== global.FG_V3.getContextEpoch()) return;

    var projects = (pRes.ok && pRes.projects) || [];
    var regs = (dRes.ok && dRes.registrations) || [];
    var companies = (cRes.ok && cRes.companies) || [];
    var compOpts = '<option value="">选择当前空间企业…</option>' + companies.map(function (c) {
      return '<option value="' + esc(c.id) + '">' + esc(c.canonical_name) + ' (' + esc(c.country_en) + ')</option>';
    }).join("");

    var html =
      '<div class="v3-grid">' +
      '  <div class="v3-card">' +
      '    <b>提交 3 层客户/项目盲查重报备 (REV07/08)</b>' +
      '    <div class="v3-field" style="margin-top:6px"><label>报备层级</label><select id="v3RegTier"><option value="relationship_reg">relationship_reg · 关系报备</option><option value="demand_reg">demand_reg · 需求报备</option><option value="project_reg">project_reg · 项目报备</option></select></div>' +
      '    <div class="v3-field" style="margin-top:6px"><label>客户企业名称 *</label><input id="v3RegCompany" placeholder="如：Gulf Water Contracting LLC"></div>' +
      '    <div class="v3-field" style="margin-top:6px"><label>国家 / 项目名（项目报备必填）</label><div class="v3-grid"><input id="v3RegCountry" placeholder="如：UAE"><input id="v3RegProj" placeholder="项目名称"></div></div>' +
      '    <div class="v3-field" style="margin-top:6px"><label>关系或需求证据</label><input id="v3RegEv" placeholder="简述采购沟通证据（仅主管查重用）"></div>' +
      '    <div class="v3-acts"><button type="button" class="pill primary" id="v3BtnSubmitReg">＋ 提交盲查重报备</button></div>' +
      '  </div>' +
      '  <div class="v3-card">' +
      '    <b>创建轻量工程/采购项目 (UX03)</b>' +
      '    <div class="v3-field" style="margin-top:6px"><label>项目名称 *</label><input id="v3PrjTitle" placeholder="如：Desalination Plant Phase 2"></div>' +
      '    <div class="v3-field" style="margin-top:6px"><label>国家与产品方向</label><div class="v3-grid"><input id="v3PrjCountry" placeholder="如：Saudi Arabia"><input id="v3PrjProd" placeholder="如：valves / pe_pipes"></div></div>' +
      '    <div class="v3-field" style="margin-top:6px"><label>供货承接判断 (UX04)</label><select id="v3PrjReady"><option value="needs_confirmation">needs_confirmation · 需技术/供应确认</option><option value="direct_supply">direct_supply · 可直接处理</option><option value="intelligence_only">intelligence_only · 暂仅情报</option></select></div>' +
      '    <div class="v3-acts"><button type="button" class="pill primary" id="v3BtnCreatePrj">＋ 创建项目</button></div>' +
      '  </div>' +
      '</div>';

    html += '<div class="v3-card"><b>报备记录与审批进度（' + regs.length + ' 条）</b>';
    if (!regs.length) html += '<p class="muted" style="margin:6px 0 0">暂无报备记录。</p>';
    regs.forEach(function (r) {
      html +=
        '<div style="border-top:1px solid var(--line);padding:8px 0;font-size:13px">' +
        '  <b>' + esc(r.reg_no) + '</b> · ' + esc(r.company_name) + ' <span class="v3-badge">' + esc(r.reg_tier) + '</span> <span class="v3-badge ok">' + esc(r.status) + ' / ' + esc(r.receipt_type) + '</span>' +
        (r.protection_cert_no ? ('<br><small>保护确认号：<code>' + esc(r.protection_cert_no) + '</code> · SHA-256：<code>' + esc(String(r.canonical_sha256 || "").slice(0, 16)) + '…</code></small>') : "") +
        (r.review_note ? ('<div style="font-size:12px;color:var(--muted)">主管反馈：' + esc(r.review_note) + '</div>') : "") +
        (Array.isArray(r.duplicateHints) && r.duplicateHints.length
          ? ('<div style="font-size:12px;color:var(--danger);margin-top:3px">⚠️ 主管可见查重提示：匹配已有企业 ' + esc(r.duplicateHints.map(function (h) { return h.canonical_name; }).join(", ")) + '</div>')
          : "") +
        (isMgr
          ? '<div class="v3-acts">' +
            '  <button type="button" class="pill primary" data-reg-rev="approve" data-rid="' + esc(r.id) + '">✅ 批准（按当前政策签发回执/保护单）</button>' +
            '  <button type="button" class="pill" data-reg-rev="need_more_info" data-rid="' + esc(r.id) + '">📝 要求补件</button>' +
            '  <button type="button" class="pill" data-reg-rev="disputed" data-rid="' + esc(r.id) + '">⚖️ 标为争议</button>' +
            '  <button type="button" class="pill" data-reg-rev="rejected" data-rid="' + esc(r.id) + '">❌ 驳回</button>' +
            '</div>'
          : "") +
        '</div>';
    });
    html += '</div>';

    html += '<div class="v3-card"><b>轻量项目与多企业采购角色（' + projects.length + ' 个）</b>';
    if (!projects.length) html += '<p class="muted" style="margin:6px 0 0">暂无项目，请在右上方新建。</p>';
    projects.forEach(function (p) {
      html +=
        '<div style="border-top:1px solid var(--line);padding:8px 0;font-size:13px">' +
        '  <b>' + esc(p.project_code) + ' · ' + esc(p.title) + '</b> <span class="v3-badge">' + esc(p.country_en || "-") + '</span> <span class="v3-badge warn">' + esc(p.fulfillment_readiness) + '</span>' +
        '  <div style="font-size:12px;color:var(--muted);margin:4px 0">参与企业角色：' + esc((p.participants || []).map(function (x) { return (x.company_name || x.company_id) + "[" + x.buyer_role + "]"; }).join(" · ") || "暂无") + '</div>' +
        '  <div class="v3-filter-bar" style="margin:6px 0 0;padding:6px 8px">' +
        '    <select data-pp-comp="' + esc(p.id) + '">' + compOpts + '</select>' +
        '    <select data-pp-role="' + esc(p.id) + '"><option value="epc">EPC总包</option><option value="owner">业主</option><option value="designer">设计方</option><option value="subcontractor">分包商</option><option value="importer">进口商</option><option value="distributor">经销商</option><option value="buyer">采购方</option><option value="unknown">未知待核实</option></select>' +
        '    <button type="button" class="pill" data-pp-add="' + esc(p.id) + '">＋ 绑定企业角色</button>' +
        '  </div>' +
        '</div>';
    });
    html += '</div>';

    body.innerHTML = html;

    body.querySelector("#v3BtnSubmitReg").addEventListener("click", async function () {
      var r = await global.FG_V3.submitDealReg({
        reg_tier: body.querySelector("#v3RegTier").value,
        company_name: body.querySelector("#v3RegCompany").value.trim(),
        country_en: body.querySelector("#v3RegCountry").value.trim(),
        project_title: body.querySelector("#v3RegProj").value.trim(),
        demand_evidence: body.querySelector("#v3RegEv").value.trim(),
      });
      toast(r.ok ? ("报备已提交（中性回执）：" + r.registration.reg_no) : ("失败：" + (r.error || r.code)));
      if (r.ok) renderCurrentTab();
    });

    body.querySelector("#v3BtnCreatePrj").addEventListener("click", async function () {
      var r = await global.FG_V3.createProject({
        title: body.querySelector("#v3PrjTitle").value.trim(),
        country_en: body.querySelector("#v3PrjCountry").value.trim(),
        product_line: body.querySelector("#v3PrjProd").value.trim(),
        fulfillment_readiness: body.querySelector("#v3PrjReady").value,
      });
      toast(r.ok ? ("项目已创建：" + r.project.project_code) : ("创建失败：" + (r.error || r.code)));
      if (r.ok) renderCurrentTab();
    });

    body.querySelectorAll("[data-pp-add]").forEach(function (b) {
      b.addEventListener("click", async function () {
        var pid = b.getAttribute("data-pp-add");
        var cid = body.querySelector('[data-pp-comp="' + pid + '"]').value;
        var role = body.querySelector('[data-pp-role="' + pid + '"]').value;
        if (!cid) { toast("请先选择一家当前空间的企业"); return; }
        var r = await global.FG_V3.addProjectParticipant(pid, { company_id: cid, buyer_role: role });
        toast(r.ok ? "已绑定项目参与企业角色" : ("绑定失败：" + (r.error || r.code)));
        if (r.ok) renderCurrentTab();
      });
    });

    body.querySelectorAll("[data-reg-rev]").forEach(function (b) {
      b.addEventListener("click", async function () {
        var dec = b.getAttribute("data-reg-rev");
        var rid = b.getAttribute("data-rid");
        var note = prompt("请输入审核反馈说明（伙伴可见，请勿泄露他方客户明细）：", dec === "approve" ? "已核实提交事实" : "请补充具体项目/采购证据") || "";
        var r = await global.FG_V3.reviewDealReg(rid, { decision: dec, review_note: note });
        toast(r.ok ? ("审批完成：" + r.status + " (" + r.receipt_type + ")") : ("审批失败：" + (r.error || r.code)));
        renderCurrentTab();
      });
    });
  }

  // =========================================================================
  // TAB 6: Applications Review/Activation (REV09), Approved Catalog (NEW01), Support Grants (REV01)
  // =========================================================================
  async function renderAdminTab(body, epoch) {
    var st = global.FG_V3.getState();
    var isMainMgr = st.activeContext.org_type === "company_main" && (st.activeContext.role === "super_admin" || st.activeContext.role === "manager");
    var isTrialOwner = st.activeContext.org_type === "independent_trial" && st.activeContext.role === "independent_user";

    var html = "";

    if (isTrialOwner) {
      var gRes = await global.FG_V3.listSupportGrants();
      if (gRes.staleContext || epoch !== global.FG_V3.getContextEpoch()) return;
      var grants = (gRes.ok && gRes.grants) || [];
      html +=
        '<div class="v3-card">' +
        '  <b>独立空间只读排障授权管理 (REV01)</b>' +
        '  <p class="muted" style="margin:4px 0">默认情况下总负责人与公司员工均无权访问您的独立数据空间；如遇故障需排查，您可签发 24h 限时只读授权并随时一键撤销。</p>' +
        '  <div class="v3-acts"><button type="button" class="pill primary" id="v3BtnCreateGrant">🔑 签发 24h 只读排障授权</button></div>' +
        '</div>';
      grants.forEach(function (g) {
        var active = !g.revoked_at && g.expires_at > new Date().toISOString();
        html +=
          '<div class="v3-card">' +
          '  <b>授权单 ' + esc(g.id) + '</b> <span class="v3-badge ' + (active ? "ok" : "") + '">' + (active ? "生效中 (只读)" : (g.revoked_at ? "已撤销" : "已过期")) + '</span>' +
          '  <div style="font-size:12px;color:var(--muted)">有效期至：' + esc(g.expires_at) + ' · 事由：' + esc(g.reason) + '</div>' +
          (active ? ('<div class="v3-acts"><button type="button" class="pill" data-revoke-grant="' + esc(g.id) + '">🔒 立即撤销授权</button></div>') : "") +
          '</div>';
      });
    }

    if (isMainMgr) {
      var [appRes, catRes] = await Promise.all([
        global.FG_V3.listApplications(),
        global.FG_V3.listCatalog(),
      ]);
      if (appRes.staleContext || epoch !== global.FG_V3.getContextEpoch()) return;
      var apps = (appRes.ok && appRes.applications) || [];
      var cats = (catRes.ok && catRes.categories) || [];

      html += '<div class="v3-card"><b>入驻申请审批与分离激活（join.html 收件箱 · ' + apps.length + ' 条）</b>';
      if (!apps.length) html += '<p class="muted" style="margin:6px 0 0">暂无待处理申请。</p>';
      apps.forEach(function (a) {
        html +=
          '<div style="border-top:1px solid var(--line);padding:8px 0;font-size:13px">' +
          '  <b>' + esc(a.application_no) + '</b> · ' + esc(a.applicant_name) + ' <span class="v3-badge">' + esc(a.app_type) + (a.partner_mode ? ("/" + esc(a.partner_mode)) : "") + '</span> <span class="v3-badge ok">' + esc(a.status) + '</span>' +
          '  <div style="font-size:12px;color:var(--muted)">联系：' + esc(a.contact_channel) + ' : ' + esc(a.contact_value) + ' · 地区/语言：' + esc(a.country_tz || "-") + ' / ' + esc(a.languages || "-") + '</div>' +
          '  <div class="v3-acts">' +
          (a.status !== "active" && a.status !== "approved"
            ? '<button type="button" class="pill" data-app-rev="approved" data-aid="' + esc(a.id) + '">✅ 初审通过 (Approve)</button>' +
              '<button type="button" class="pill" data-app-rev="need_more_info" data-aid="' + esc(a.id) + '">📝 需补资料</button>' +
              '<button type="button" class="pill" data-app-rev="rejected" data-aid="' + esc(a.id) + '">❌ 拒绝</button>'
            : "") +
          (a.status === "approved" || a.status === "training"
            ? '<button type="button" class="pill primary" data-app-act="' + esc(a.id) + '" data-atype="' + esc(a.app_type) + '">🚀 正式激活账号与空间</button>'
            : "") +
          '  </div>' +
          '</div>';
      });
      html += '</div>';

      html +=
        '<div class="v3-card">' +
        '  <b>核验产品目录与认证维护 (NEW01 — 仅已审批且未过期条目对外展示于 rfq.html 与回复草稿)</b>' +
        '  <div class="v3-grid" style="margin-top:8px">' +
        '    <div class="v3-field"><label>品类键 *</label><input id="v3CatKey" placeholder="如：valves / pe_pipes / cables / steel_structures"></div>' +
        '    <div class="v3-field"><label>供货状态</label><select id="v3CatStatus"><option value="direct_supply">direct_supply · 可直接处理</option><option value="needs_confirmation">needs_confirmation · 需技术/供应确认</option><option value="intelligence_only">intelligence_only · 暂仅情报</option></select></div>' +
        '    <div class="v3-field"><label>英文品名 *</label><input id="v3CatEn" placeholder="e.g. Industrial Gate & Ball Valves"></div>' +
        '    <div class="v3-field"><label>中文品名 *</label><input id="v3CatCn" placeholder="如：工业阀门系列"></div>' +
        '    <div class="v3-field"><label>已核实认证（逗号分隔，未核实勿填）</label><input id="v3CatCerts" placeholder="如：ISO 9001, API 600"></div>' +
        '    <div class="v3-field"><label>MOQ / 供货备注</label><input id="v3CatMoq" placeholder="如：按项目规格核定"></div>' +
        '  </div>' +
        '  <div class="v3-acts"><button type="button" class="pill primary" id="v3BtnSaveCat">💾 审批并发布至公开核验目录</button></div>' +
        '  <div style="margin-top:10px">' +
        cats.map(function (c) {
          return '<div style="border-top:1px solid var(--line);padding:6px 0;font-size:12.5px"><b>' + esc(c.category_key) + '</b> (' + esc(c.title_cn) + ' / ' + esc(c.title_en) + ') · <span class="v3-badge">' + esc(c.supply_status) + '</span> · 认证：' + esc((c.verified_certs || []).join(", ") || "无") + ' · v' + Number(c.catalog_version || 1) + '</div>';
        }).join("") +
        '  </div>' +
        '</div>';
    }

    if (!isMainMgr && !isTrialOwner) {
      html = '<div class="v3-card"><b>权限提示</b><p class="muted" style="margin:4px 0">入驻审核与产品目录审批仅对公司主管/总负责人开放；独立空间排障授权仅对独立试用空间所有者开放。</p></div>';
    }

    body.innerHTML = html;

    var btnGrant = body.querySelector("#v3BtnCreateGrant");
    if (btnGrant) {
      btnGrant.addEventListener("click", async function () {
        var r = await global.FG_V3.createSupportGrant({ ttl_hours: 24, reason: "user_diagnostics_request" });
        toast(r.ok ? "已签发 24 小时只读排障授权" : ("失败：" + (r.error || r.code)));
        renderCurrentTab();
      });
    }
    body.querySelectorAll("[data-revoke-grant]").forEach(function (b) {
      b.addEventListener("click", async function () {
        var r = await global.FG_V3.revokeSupportGrant(b.getAttribute("data-revoke-grant"));
        toast(r.ok ? "已立即撤销只读排障授权" : ("撤销失败：" + r.error));
        renderCurrentTab();
      });
    });
    body.querySelectorAll("[data-app-rev]").forEach(function (b) {
      b.addEventListener("click", async function () {
        var stNext = b.getAttribute("data-app-rev");
        var note = prompt("审核备注（选填）：", "") || "";
        var r = await global.FG_V3.reviewApplication(b.getAttribute("data-aid"), { status: stNext, review_note: note });
        toast(r.ok ? ("申请状态已更新为：" + stNext) : ("失败：" + (r.error || r.code)));
        renderCurrentTab();
      });
    });
    body.querySelectorAll("[data-app-act]").forEach(function (b) {
      b.addEventListener("click", async function () {
        var aid = b.getAttribute("data-app-act");
        var atype = b.getAttribute("data-atype");
        var loginId = prompt("请为新成员设定登录名 login_id（如 ptn_alex）：", "");
        if (!loginId) return;
        var payload = { login_id: loginId.trim() };
        if (atype === "partner") {
          payload.partner_approved_title = prompt("请输入经批准的对外伙伴称谓：", "Authorized Partner Contact") || "Authorized Partner Contact";
        }
        var r = await global.FG_V3.activateApplication(aid, payload);
        if (r.ok) {
          var summary = "激活成功！登录名：" + r.login_id + " | 组织：" + r.org_id + " | 角色：" + r.role + (r.initial_password_once ? (" | 初始密码(仅本次显示)：" + r.initial_password_once) : "") + (r.partner_ref_code ? (" | 推荐码：" + r.partner_ref_code) : "");
          copyText(summary, "账号已正式激活并复制凭证摘要");
          alert(summary);
          renderCurrentTab();
        } else {
          toast("激活失败：" + (r.error || r.code));
        }
      });
    });
    var btnSaveCat = body.querySelector("#v3BtnSaveCat");
    if (btnSaveCat) {
      btnSaveCat.addEventListener("click", async function () {
        var key = body.querySelector("#v3CatKey").value.trim();
        if (!key) { toast("请填写品类键"); return; }
        var r = await global.FG_V3.upsertCatalog(key, {
          title_en: body.querySelector("#v3CatEn").value.trim() || key,
          title_cn: body.querySelector("#v3CatCn").value.trim() || key,
          supply_status: body.querySelector("#v3CatStatus").value,
          verified_certs: body.querySelector("#v3CatCerts").value.split(/[,，]/).map(function (x) { return x.trim(); }).filter(Boolean),
          moq_note: body.querySelector("#v3CatMoq").value.trim(),
        });
        toast(r.ok ? ("已审批发布目录：" + r.category_key + " v" + r.catalog_version) : ("保存失败：" + (r.error || r.code)));
        if (r.ok) renderCurrentTab();
      });
    }
  }

  async function openHub(tab) {
    ensureModal();
    if (tab) activeTab = tab;
    modalEl.hidden = false;
    modalEl.querySelectorAll("[data-v3tab]").forEach(function (b) {
      b.classList.toggle("primary", b.getAttribute("data-v3tab") === activeTab);
    });
    if (global.FG_V3) {
      await global.FG_V3.loadContexts();
    }
    renderCurrentTab();
  }

  function closeHub() {
    if (modalEl) modalEl.hidden = true;
  }

  if (global.FG_V3 && typeof global.FG_V3.subscribe === "function") {
    global.FG_V3.subscribe(function (st) {
      if (!modalEl || modalEl.hidden) return;
      renderContextBar();
      if (!st.contexts.length && !st.activeContext) {
        var body = modalEl.querySelector("#v3Body");
        if (body) body.innerHTML = '<div class="v3-card"><b>会话已重置</b><p class="muted">请重新登录后选择工作空间。</p></div>';
      }
    });
  }

  function checkDeepLink() {
    var h = String(location.hash || "");
    if (h === "#v3-hub" || h.indexOf("#v3-todo=") === 0) {
      openHub("todos");
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    var btn = document.getElementById("btnOpenV3Hub");
    if (btn) btn.addEventListener("click", function () { openHub("todos"); });
    checkDeepLink();
  });
  window.addEventListener("hashchange", checkDeepLink);

  global.FG_V3_UI = {
    openHub: openHub,
    closeHub: closeHub,
    setTab: setTab,
    renderCurrentTab: renderCurrentTab,
  };
})(typeof window !== "undefined" ? window : globalThis);
