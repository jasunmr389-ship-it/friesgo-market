/* FriesGo Global V3.0 Slice 1: Operational Growth, Social Demand Discovery & Partner Hub UI
 * Mounts cleanly as a dedicated full-featured workspace drawer/modal without bloating index.html.
 * Covers:
 *   - Explicit multi-tenant context switcher (REV01)
 *   - Today's Action Queue + Personal WeChat Desensitized Card copy (UX02)
 *   - FB / IG / LI Discovery Tasks (API status honestly marked "人工工作流 / API待授权"; YouTube excluded from round-1)
 *   - Candidate Intake, 4-tier Audit, Reply Draft vs Confirmed Manual Send separation (ACQ04-09)
 *   - Source Comparison with honest denominators & small-sample warnings (ACQ10)
 *   - Lightweight Projects/Buyer Roles, 3-tier Blind-Dedupe Deal Reg, Applications & Support Grants (UX03/05, REV07-09)
 */
(function (global) {
  "use strict";

  var modalEl = null;
  var activeTab = "todos"; // todos | tasks | signals | compare | projects

  function esc(s) {
    return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c];
    });
  }

  function toast(msg) {
    if (typeof global.showToast === "function") global.showToast(msg);
    else if (modalEl) {
      var bar = modalEl.querySelector("#v3ToastBar");
      if (bar) {
        bar.textContent = msg;
        bar.hidden = false;
        setTimeout(function () { bar.hidden = true; }, 3500);
      }
    }
  }

  function ensureModal() {
    if (modalEl) return modalEl;
    modalEl = document.createElement("div");
    modalEl.id = "v3GrowthHubBackdrop";
    modalEl.className = "fg-modal-backdrop";
    modalEl.hidden = true;
    modalEl.innerHTML =
      '<div class="fg-modal-dialog" style="max-width:1040px;width:96vw;max-height:92vh;display:flex;flex-direction:column;gap:10px">' +
      '  <div class="fg-modal-head" style="border-bottom:1px solid var(--line);padding-bottom:8px;margin-bottom:0;flex-wrap:wrap">' +
      '    <div>' +
      '      <h3 style="margin:0">🤝 社媒需求发现 · 来源比较与伙伴协作中心 (V3 Slice 1)</h3>' +
      '      <div style="font-size:12px;color:var(--muted)">首轮平台：Facebook · Instagram · LinkedIn（人工工作流；官方API均未接入）｜YouTube 列为后续候选</div>' +
      '    </div>' +
      '    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
      '      <select id="v3ContextSelect" aria-label="切换数据空间" style="min-height:32px;padding:2px 8px;border:1px solid var(--line);border-radius:8px;background:var(--surface2);color:var(--ink);font-size:12px"></select>' +
      '      <button type="button" class="pill" id="v3BtnClose" style="min-height:32px;padding:2px 10px">✕ 关闭</button>' +
      '    </div>' +
      '  </div>' +
      '  <div id="v3ToastBar" class="v2-guard-bar lv-green" hidden style="margin:0"></div>' +
      '  <div id="v3ContextBanner" class="v2-guard-bar lv-yellow" style="margin:0;font-size:12px"></div>' +
      '  <div style="display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:8px" id="v3TabBar">' +
      '    <button type="button" class="pill primary" data-v3tab="todos">📋 今日行动与微信卡</button>' +
      '    <button type="button" class="pill" data-v3tab="tasks">🎯 发现任务 (FB/IG/LI)</button>' +
      '    <button type="button" class="pill" data-v3tab="signals">🔎 候选登记 / 审核 / 草稿</button>' +
      '    <button type="button" class="pill" data-v3tab="compare">📊 来源效果对比</button>' +
      '    <button type="button" class="pill" data-v3tab="projects">🏗️ 项目 / 报备 / 入驻</button>' +
      '  </div>' +
      '  <div id="v3Body" style="overflow-y:auto;flex:1;min-height:320px;padding-right:4px"></div>' +
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
        activeTab = btn.getAttribute("data-v3tab");
        modalEl.querySelectorAll("[data-v3tab]").forEach(function (b) {
          b.classList.toggle("primary", b.getAttribute("data-v3tab") === activeTab);
        });
        renderCurrentTab();
      });
    });

    return modalEl;
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
      banner.className = "v2-guard-bar lv-green";
      banner.innerHTML =
        "<b>当前空间：</b>" + esc(st.activeContext.org_name) +
        " · <b>组织类型：</b>" + esc(st.activeContext.org_type) +
        " · <b>角色：</b>" + esc(st.activeContext.role) +
        " · <b>隔离纪元：</b>#" + st.contextEpoch +
        (st.activeContext.partner_ref_code ? (" · <b>专属推荐码：</b><code>" + esc(st.activeContext.partner_ref_code) + "</code>") : "");
    }
  }

  async function renderCurrentTab() {
    if (!modalEl || !global.FG_V3) return;
    renderContextBar();
    var body = modalEl.querySelector("#v3Body");
    var st = global.FG_V3.getState();
    var cloudSt = global.FG_CLOUD && global.FG_CLOUD.getState();
    if (!cloudSt || !cloudSt.loggedIn) {
      body.innerHTML = '<div class="card"><b>需要成员登录</b><p class="muted">请先点击顶部「🔒 成员登录」认证身份后再进入 V3 获客与伙伴协作中心。</p></div>';
      return;
    }
    if (!st.activeContext) {
      body.innerHTML = '<div class="card"><b>请选择数据空间</b><p class="muted">检测到您拥有多个组织角色或尚未选择上下文，请先在右上角选择目标数据空间。</p></div>';
      return;
    }

    var epochAtStart = st.contextEpoch;
    body.innerHTML = '<p class="muted">正在从当前隔离空间加载数据…</p>';

    if (activeTab === "todos") await renderTodosTab(body, epochAtStart);
    else if (activeTab === "tasks") await renderTasksTab(body, epochAtStart);
    else if (activeTab === "signals") await renderSignalsTab(body, epochAtStart);
    else if (activeTab === "compare") await renderCompareTab(body, epochAtStart);
    else if (activeTab === "projects") await renderProjectsTab(body, epochAtStart);
  }

  async function renderTodosTab(body, epoch) {
    var st = global.FG_V3.getState();
    var isMgr = st.activeContext.role === "super_admin" || st.activeContext.role === "manager";
    var res = await global.FG_V3.listTodos(isMgr ? "all" : "");
    if (res.staleContext || epoch !== global.FG_V3.getContextEpoch()) return;
    if (!res.ok) {
      body.innerHTML = '<div class="v2-guard-bar lv-red">' + esc(res.error || "加载待办失败") + '</div>';
      return;
    }
    var todos = res.todos || [];
    if (!todos.length) {
      body.innerHTML = '<div class="card"><b>今日行动队列为空</b><p class="muted">在「候选登记 / 审核」中核实并推进需求，或接收买方 RFQ 后，待办任务会自动出现在这里。</p></div>';
      return;
    }
    var html = '<div style="display:flex;flex-direction:column;gap:10px">';
    todos.forEach(function (t) {
      html +=
        '<div class="card" style="padding:12px">' +
        '  <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">' +
        '    <b>' + esc(t.inquiry_no || t.project_title || t.id) + ' · ' + esc(t.sig_country || "国家待核实") + ' / ' + esc(t.sig_product || "品类待确认") + '</b>' +
        '    <span class="meta-pill">' + esc(t.action_bucket) + ' · ' + esc(t.assignment_status) + '</span>' +
        '  </div>' +
        '  <div style="font-size:13px;margin:6px 0">' + esc(t.demand_summary || "—") + '</div>' +
        '  <div style="font-size:12px;color:var(--muted)">来源：' + esc(t.source_platform || "-") + ' (' + esc(t.acquisition_mode || "-") + ') · 联系状态：' + esc(t.contact_result || "-") + ' · 草稿：' + Number(t.draft_count || 0) + ' / 复制：' + Number(t.copy_count || 0) + ' / <b>实发：' + Number(t.manual_sent_count || 0) + '</b></div>' +
        '  <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">' +
        (t.assignment_status === "pending_accept"
          ? '<button type="button" class="pill primary" data-act-accept="' + esc(t.id) + '" data-ver="' + Number(t.version || 1) + '">✅ 确认接单</button>' +
            '<button type="button" class="pill" data-act-reject="' + esc(t.id) + '">↩️ 拒单并说明原因</button>'
          : "") +
        '    <button type="button" class="pill" data-copy-wx="' + esc(t.id) + '">💬 复制个人微信脱敏提醒卡</button>' +
        '  </div>' +
        '</div>';
    });
    html += '</div>';
    body.innerHTML = html;

    body.querySelectorAll("[data-act-accept]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var id = btn.getAttribute("data-act-accept");
        var ver = Number(btn.getAttribute("data-ver") || 1);
        var r = await global.FG_V3.acceptDispatch(id, { version: ver }, "acc_" + id + "_" + ver);
        toast(r.ok ? "接单成功（原子写入事件已记录）" : ("接单失败：" + (r.error || r.code)));
        renderCurrentTab();
      });
    });
    body.querySelectorAll("[data-act-reject]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var id = btn.getAttribute("data-act-reject");
        var reason = prompt("请输入拒单原因（便于主管改派）：", "暂不覆盖该语言/品类");
        if (!reason) return;
        var r = await global.FG_V3.rejectDispatch(id, { reason: reason });
        toast(r.ok ? "已退回派单池" : ("操作失败：" + (r.error || r.code)));
        renderCurrentTab();
      });
    });
    body.querySelectorAll("[data-copy-wx]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-copy-wx");
        var item = todos.find(function (x) { return x.id === id; });
        if (item && navigator.clipboard) {
          navigator.clipboard.writeText(item.wechatSafeCard).then(function () {
            toast("已复制个人微信脱敏提醒卡（不含客户敏感联系方式与报价）");
          });
        }
      });
    });
  }

  async function renderTasksTab(body, epoch) {
    var res = await global.FG_V3.listTasks();
    if (res.staleContext || epoch !== global.FG_V3.getContextEpoch()) return;
    var tasks = (res.ok && res.tasks) || [];
    var html =
      '<div class="card" style="padding:12px;margin-bottom:12px">' +
      '  <b>新建社媒需求发现任务（首轮不限品类与国家，先比较 FB / IG / LI 来源）</b>' +
      '  <div class="form-grid" style="margin-top:8px">' +
      '    <div><label>平台（官方API均待授权，首轮为人工工作流）</label><select id="v3TaskPlat"><option value="facebook">Facebook (首轮)</option><option value="instagram">Instagram (首轮)</option><option value="linkedin">LinkedIn (首轮)</option><option value="youtube">YouTube (后续候选·不计入首轮)</option></select></div>' +
      '    <div><label>获客方式（严格区分统计）</label><select id="v3TaskMode"><option value="manual_discovery">manual_discovery · 主动人工发现</option><option value="owned_account_inquiry">owned_account_inquiry · 自有账号主动咨询</option><option value="owned_ad_form">owned_ad_form · 自有广告表单</option></select></div>' +
      '    <div><label>任务名称 *</label><input id="v3TaskTitle" placeholder="如：FB 工业采购群 W1 需求对比"></div>' +
      '    <div><label>国家范围（默认 ANY 不限）</label><input id="v3TaskCountry" value="ANY"></div>' +
      '    <div><label>产品关键词（选填，不强限四大品类）</label><input id="v3TaskProd" placeholder="如：valve, HDPE pipe, cable, steel 或留空"></div>' +
      '    <div><label>采购意图词（检索示例）</label><input id="v3TaskIntent" value="looking for supplier, RFQ, need distributor"></div>' +
      '  </div>' +
      '  <div style="margin-top:8px"><button type="button" class="pill primary" id="v3BtnCreateTask">＋ 创建发现任务</button></div>' +
      '</div>';

    html += '<div style="display:flex;flex-direction:column;gap:8px">';
    tasks.forEach(function (t) {
      var hrs = (Number(t.hours_logged_tenths || 0) / 10).toFixed(1);
      var spendTxt = t.actual_spend_minor === null || t.actual_spend_minor === undefined ? "未知（未记录费用）" : ((Number(t.actual_spend_minor) / 100).toFixed(2) + " " + (t.spend_currency || "USD"));
      html +=
        '<div class="card" style="padding:10px">' +
        '  <b>[' + esc(t.platform.toUpperCase()) + ' · ' + esc(t.acquisition_mode) + '] ' + esc(t.title) + '</b>' +
        '  <div style="font-size:12px;color:var(--muted)">国家范围：' + esc(t.country_scope) + ' · 累计人工工时：<b>' + hrs + 'h</b> · 实际支出：' + esc(spendTxt) + ' · 状态：' + esc(t.status) + '</div>' +
        '  <div style="margin-top:6px"><button type="button" class="pill" data-add-hr="' + esc(t.id) + '">⏱️ +0.5h 工时记录</button></div>' +
        '</div>';
    });
    html += '</div>';
    body.innerHTML = html;

    var btnCreate = body.querySelector("#v3BtnCreateTask");
    if (btnCreate) {
      btnCreate.addEventListener("click", async function () {
        var r = await global.FG_V3.createTask({
          platform: body.querySelector("#v3TaskPlat").value,
          acquisition_mode: body.querySelector("#v3TaskMode").value,
          title: body.querySelector("#v3TaskTitle").value.trim(),
          country_scope: body.querySelector("#v3TaskCountry").value.trim() || "ANY",
          product_keywords: body.querySelector("#v3TaskProd").value.trim(),
          intent_keywords: body.querySelector("#v3TaskIntent").value.trim(),
        });
        toast(r.ok ? "发现任务已创建" : ("创建失败：" + (r.error || r.code)));
        if (r.ok) renderCurrentTab();
      });
    }
    body.querySelectorAll("[data-add-hr]").forEach(function (b) {
      b.addEventListener("click", async function () {
        var r = await global.FG_V3.patchTask(b.getAttribute("data-add-hr"), { add_hours_tenths: 5 });
        toast(r.ok ? "已追加 0.5h 人工投入工时" : ("更新失败：" + (r.error || r.code)));
        if (r.ok) renderCurrentTab();
      });
    });
  }

  async function renderSignalsTab(body, epoch) {
    var res = await global.FG_V3.listSignals();
    if (res.staleContext || epoch !== global.FG_V3.getContextEpoch()) return;
    var signals = (res.ok && res.signals) || [];
    var savedDraft = global.FG_V3.loadScopedDraft("signal") || {};

    var html =
      '<div class="card" style="padding:12px;margin-bottom:12px">' +
      '  <b>登记社媒候选需求信号（草稿按账号+组织隔离；发布时间未知请留空，严禁编造）</b>' +
      '  <div class="form-grid" style="margin-top:8px">' +
      '    <div><label>来源平台</label><select id="v3SigPlat"><option value="facebook">Facebook</option><option value="instagram">Instagram</option><option value="linkedin">LinkedIn</option><option value="youtube">YouTube (后续候选)</option><option value="website">Website</option></select></div>' +
      '    <div><label>获客方式</label><select id="v3SigMode"><option value="manual_discovery">manual_discovery · 主动人工发现</option><option value="owned_account_inquiry">owned_account_inquiry · 自有账号咨询</option><option value="owned_ad_form">owned_ad_form · 自有广告表单</option></select></div>' +
      '    <div><label>国家（选填，未知可留空）</label><input id="v3SigCountry" value="' + esc(savedDraft.country_en || "") + '" placeholder="如：UAE / Vietnam / 留空"></div>' +
      '    <div><label>产品方向（选填，不限品类）</label><input id="v3SigProd" value="' + esc(savedDraft.product_line || "") + '" placeholder="如：pe_pipes / valves / 其他"></div>' +
      '    <div><label>买家角色</label><select id="v3SigRole"><option value="unknown">unknown · 待核实</option><option value="epc">EPC 总包</option><option value="importer">进口商</option><option value="distributor">经销商</option><option value="owner">业主</option><option value="buyer">采购方</option></select></div>' +
      '    <div><label>原始链接 / 来源标识（选填）</label><input id="v3SigUrl" value="' + esc(savedDraft.source_url || "") + '" placeholder="仅记录允许留存的来源链接或 ID"></div>' +
      '    <div style="grid-column:1/-1"><label>需求摘要 *</label><textarea id="v3SigSummary" placeholder="记录买方真实采购表述与背景证据（勿整段复制无关群聊）">' + esc(savedDraft.demand_summary || "") + '</textarea></div>' +
      '  </div>' +
      '  <div style="margin-top:8px"><button type="button" class="pill primary" id="v3BtnCreateSig">＋ 登记候选信号</button></div>' +
      '</div>';

    html += '<div style="display:flex;flex-direction:column;gap:8px">';
    signals.forEach(function (s) {
      var reasons = (s.judgment_tags && s.judgment_tags.reasons) || [];
      html +=
        '<div class="card" style="padding:10px">' +
        '  <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">' +
        '    <b>[' + esc(s.source_platform.toUpperCase()) + ' · ' + esc(s.acquisition_mode) + '] ' + esc(s.country_en || "国家未知") + ' / ' + esc(s.product_line || "品类待确认") + '</b>' +
        '    <span class="meta-pill">审核:' + esc(s.audit_status) + ' · 联系:' + esc(s.contact_result) + '</span>' +
        '  </div>' +
        '  <div style="font-size:13px;margin:4px 0">' + esc(s.demand_summary) + '</div>' +
        '  <div style="font-size:12px;color:var(--muted)">可解释判断：' + esc(reasons.join("；") || "待人工核实") + ' ｜ 缺失项：' + esc((s.missing_info || []).join(", ") || "无") + '</div>' +
        '  <div style="font-size:12px;color:var(--muted)">草稿：' + Number(s.draft_count || 0) + ' ｜ 复制：' + Number(s.copy_count || 0) + '（不计触达） ｜ <b>人工实发：' + Number(s.manual_sent_count || 0) + '</b></div>' +
        '  <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">' +
        (s.audit_status === "pending_verify"
          ? '<button type="button" class="pill primary" data-audit-ok="' + esc(s.id) + '">✅ 核实有效并建开发单</button>' +
            '<button type="button" class="pill" data-audit-ad="' + esc(s.id) + '">🚫 标为同行广告</button>'
          : "") +
        '    <button type="button" class="pill" data-gen-draft="' + esc(s.id) + '">✍️ 生成草稿</button>' +
        '    <button type="button" class="pill" data-act-copy="' + esc(s.id) + '">📋 记录复制(不计触达)</button>' +
        '    <button type="button" class="pill" data-act-sent="' + esc(s.id) + '">📨 确认已人工发送</button>' +
        '    <button type="button" class="pill" data-act-replied="' + esc(s.id) + '">💬 登记买方回复</button>' +
        '    <button type="button" class="pill" data-act-inq="' + esc(s.id) + '">📄 转为正式询盘</button>' +
        '  </div>' +
        '  <div id="v3DraftOut_' + esc(s.id) + '" class="fb-ctx-box" hidden></div>' +
        '</div>';
    });
    html += '</div>';
    body.innerHTML = html;

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

    body.querySelector("#v3BtnCreateSig").addEventListener("click", async function () {
      var r = await global.FG_V3.createSignal({
        source_platform: body.querySelector("#v3SigPlat").value,
        acquisition_mode: body.querySelector("#v3SigMode").value,
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
        toast("登记失败（草稿已保留）：" + (r.error || r.code));
      }
    });

    body.querySelectorAll("[data-audit-ok]").forEach(function (b) {
      b.addEventListener("click", async function () {
        var r = await global.FG_V3.auditSignal(b.getAttribute("data-audit-ok"), { audit_status: "verified_valid", promote_to: "dev_lead", audit_reason: "人工核实有效" });
        toast(r.ok ? (r.duplicateDispatchPrevented ? "已核实（同需求已存在有效派单，未重复派发）" : "已核实有效并生成待派发任务") : ("失败：" + r.error));
        renderCurrentTab();
      });
    });
    body.querySelectorAll("[data-audit-ad]").forEach(function (b) {
      b.addEventListener("click", async function () {
        var r = await global.FG_V3.auditSignal(b.getAttribute("data-audit-ad"), { audit_status: "seller_ad", audit_reason: "同行卖货广告" });
        toast(r.ok ? "已归类为同行卖货广告" : ("失败：" + r.error));
        renderCurrentTab();
      });
    });
    body.querySelectorAll("[data-gen-draft]").forEach(function (b) {
      b.addEventListener("click", async function () {
        var sid = b.getAttribute("data-gen-draft");
        var r = await global.FG_V3.generateDraft(sid, { lang: "en" });
        var box = body.querySelector("#v3DraftOut_" + sid);
        if (box && r.ok) {
          box.textContent = r.draftText + "\n\n[" + r.notice + "]";
          box.hidden = false;
        }
      });
    });
    body.querySelectorAll("[data-act-copy]").forEach(function (b) {
      b.addEventListener("click", async function () {
        var r = await global.FG_V3.logContactAction(b.getAttribute("data-act-copy"), { action: "copied" });
        toast(r.ok ? "已记录复制次数（严格不计入人工触达）" : ("失败：" + r.error));
        renderCurrentTab();
      });
    });
    body.querySelectorAll("[data-act-sent]").forEach(function (b) {
      b.addEventListener("click", async function () {
        var r = await global.FG_V3.logContactAction(b.getAttribute("data-act-sent"), { action: "manual_sent" });
        toast(r.ok ? "已登记人工实际发送" : ("拦截：" + (r.error || r.code)));
        renderCurrentTab();
      });
    });
    body.querySelectorAll("[data-act-replied]").forEach(function (b) {
      b.addEventListener("click", async function () {
        var r = await global.FG_V3.logContactAction(b.getAttribute("data-act-replied"), { action: "replied" });
        toast(r.ok ? "已登记买方有效回复" : ("失败：" + r.error));
        renderCurrentTab();
      });
    });
    body.querySelectorAll("[data-act-inq]").forEach(function (b) {
      b.addEventListener("click", async function () {
        var r = await global.FG_V3.logContactAction(b.getAttribute("data-act-inq"), { action: "convert_inquiry" });
        toast(r.ok ? ("已转为正式询盘 " + (r.inquiry_no || "")) : ("失败：" + r.error));
        renderCurrentTab();
      });
    });
  }

  async function renderCompareTab(body, epoch) {
    var res = await global.FG_V3.getSourceComparison();
    if (res.staleContext || epoch !== global.FG_V3.getContextEpoch()) return;
    if (!res.ok) {
      body.innerHTML = '<div class="v2-guard-bar lv-red">' + esc(res.error || "无权查看来源比较") + '</div>';
      return;
    }
    var rows = res.groups || [];
    var html =
      '<div class="v2-guard-bar lv-yellow" style="margin-bottom:10px">' +
      '  <b>同口径分母约束 (ACQ10)：</b>核实有效率 = 已核实有效 / 已完成核实（待核实单列）；回复率 = 有效回复 / 人工实发（草稿与复制不计入）；未记录费用显示「未知」，绝不显示虚假 0 成本；YouTube 不计入首轮统计。' +
      '</div>';
    if (!rows.length) {
      html += '<div class="card"><b>暂无首轮来源样本</b><p class="muted">请先在「候选登记」中登记 Facebook / Instagram / LinkedIn 样本。</p></div>';
    } else {
      html +=
        '<div class="mini-scroll"><table><thead><tr>' +
        '<th>平台 / 获客方式</th><th>已查候选</th><th>待核实</th><th>核实有效/已核实(率)</th><th>草稿/复制</th><th>人工实发</th><th>有效回复(率)</th><th>询盘/已报价</th><th>工时(h)</th><th>实际费用</th>' +
        '</tr></thead><tbody>';
      rows.forEach(function (g) {
        var vRate = g.verified_valid_rate_pct === null ? "—" : (g.verified_valid_rate_pct + "%");
        var rRate = g.reply_rate_pct === null ? "—" : (g.reply_rate_pct + "%");
        var hrs = g.hours_logged_tenths === null ? "未知" : (g.hours_logged_tenths / 10).toFixed(1);
        var spend = g.actual_spend_minor === null ? "未知" : (g.actual_spend_minor / 100).toFixed(2);
        html +=
          '<tr>' +
          '<td><b>' + esc(g.source_platform) + '</b><br><small>' + esc(g.acquisition_mode) + (g.small_sample_warning ? ' · ⚠️小样本(n<20)' : '') + '</small></td>' +
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
      html += '</tbody></table></div>';
    }
    body.innerHTML = html;
  }

  async function renderProjectsTab(body, epoch) {
    var st = global.FG_V3.getState();
    var pRes = await global.FG_V3.listProjects();
    var dRes = await global.FG_V3.listDealRegs();
    if (pRes.staleContext || epoch !== global.FG_V3.getContextEpoch()) return;

    var html =
      '<div class="card" style="padding:12px;margin-bottom:12px">' +
      '  <b>提交客户/项目盲查重报备 (REV07/08)</b>' +
      '  <div class="form-grid" style="margin-top:8px">' +
      '    <div><label>报备层级</label><select id="v3RegTier"><option value="relationship_reg">relationship_reg · 关系报备</option><option value="demand_reg">demand_reg · 需求报备</option><option value="project_reg">project_reg · 项目报备</option></select></div>' +
      '    <div><label>客户企业名称 *</label><input id="v3RegCompany" placeholder="如：Gulf Water Contracting LLC"></div>' +
      '    <div><label>国家</label><input id="v3RegCountry" placeholder="如：UAE"></div>' +
      '    <div><label>项目名称（项目报备必填）</label><input id="v3RegProj" placeholder="如：Desalination Plant Phase 2"></div>' +
      '    <div style="grid-column:1/-1"><label>关系或需求证据</label><input id="v3RegEv" placeholder="简述采购沟通证据（仅用于内部主管查重审核）"></div>' +
      '  </div>' +
      '  <div style="margin-top:8px"><button type="button" class="pill primary" id="v3BtnSubmitReg">＋ 提交盲查重报备</button></div>' +
      '</div>';

    var regs = (dRes.ok && dRes.registrations) || [];
    html += '<div class="card" style="padding:12px;margin-bottom:12px"><b>报备记录（' + regs.length + ' 条）</b>';
    regs.forEach(function (r) {
      html +=
        '<div style="border-top:1px solid var(--line);padding:8px 0;font-size:13px">' +
        '<b>' + esc(r.reg_no) + '</b> · ' + esc(r.company_name) + ' [' + esc(r.reg_tier) + '] · 状态：<b>' + esc(r.status) + '</b> (' + esc(r.receipt_type) + ')' +
        (Array.isArray(r.duplicateHints) && r.duplicateHints.length ? ('<br><span style="color:var(--danger)">⚠️ 主管可见查重提示：匹配已有企业 ' + esc(r.duplicateHints.map(function (h) { return h.canonical_name; }).join(", ")) + '</span>') : "") +
        '</div>';
    });
    html += '</div>';

    var projects = (pRes.ok && pRes.projects) || [];
    html += '<div class="card" style="padding:12px"><b>轻量项目与采购角色（' + projects.length + ' 个）</b>';
    projects.forEach(function (p) {
      html +=
        '<div style="border-top:1px solid var(--line);padding:8px 0;font-size:13px">' +
        '<b>' + esc(p.project_code) + ' · ' + esc(p.title) + '</b> (' + esc(p.country_en || "-") + ' · ' + esc(p.fulfillment_readiness) + ')' +
        '<div style="font-size:12px;color:var(--muted)">参与企业：' + esc((p.participants || []).map(function (x) { return (x.company_name || x.company_id) + "[" + x.buyer_role + "]"; }).join(" · ") || "暂无") + '</div>' +
        '</div>';
    });
    html += '</div>';

    if (st.activeContext.org_type === "independent_trial" && st.activeContext.role === "independent_user") {
      html +=
        '<div class="card" style="padding:12px;margin-top:12px">' +
        '  <b>独立空间排障授权管理 (REV01)</b>' +
        '  <p class="muted" style="margin:4px 0">默认情况下总负责人无法访问您的独立空间；您可按需签发限时只读排障授权并随时撤销。</p>' +
        '  <button type="button" class="pill" id="v3BtnGrantSupport">🔑 签发 24h 只读排障授权</button>' +
        '</div>';
    }

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

    var grantBtn = body.querySelector("#v3BtnGrantSupport");
    if (grantBtn) {
      grantBtn.addEventListener("click", async function () {
        var r = await global.FG_V3.createSupportGrant({ ttl_hours: 24, reason: "user_requested_diagnostics" });
        toast(r.ok ? "已签发 24 小时只读排障授权（可随时撤销）" : ("失败：" + r.error));
      });
    }
  }

  async function openHub(tab) {
    ensureModal();
    if (tab) activeTab = tab;
    modalEl.hidden = false;
    if (global.FG_V3) {
      await global.FG_V3.loadContexts();
    }
    renderCurrentTab();
  }

  function closeHub() {
    if (modalEl) modalEl.hidden = true;
  }

  // Subscribe to context changes so logout/401 immediately clears & closes the hub (REV01/R07)
  if (global.FG_V3 && typeof global.FG_V3.subscribe === "function") {
    global.FG_V3.subscribe(function (st) {
      if (!modalEl || modalEl.hidden) return;
      renderContextBar();
      if (!st.contexts.length && !st.activeContext) {
        var body = modalEl.querySelector("#v3Body");
        if (body) body.innerHTML = '<div class="card"><b>会话已重置</b><p class="muted">请重新登录后选择工作空间。</p></div>';
      }
    });
  }

  // Support WeChat WebView deep-link hash #v3-hub or #v3-todo=...
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
    renderCurrentTab: renderCurrentTab,
  };
})(typeof window !== "undefined" ? window : globalThis);
