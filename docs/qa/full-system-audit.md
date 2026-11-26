# FriesGo Global — 全系统工程交叉验收与第二轮整改审计报告

- **审计日期**：2026-11-26
- **代码仓库**：`jasunmr389-ship-it/friesgo-market`（原生无构建静态架构：HTML + CSS + Vanilla JS + Cloudflare Worker）
- **基线版本对照**：
  - 第一轮前原始基线：`413f04f`（备份标签 `backup/pre-phase1-413f04f`）
  - 第一轮合并基线：`a0a5ccc`（备份标签 `backup/pre-round2-a0a5ccc`）
  - 第二轮整改分支：`fix/phase1-round2-audit`（待用户确认后快进合并至 `main` 并核验 GitHub Pages 线上一致性）

---

## 一、第二轮交叉审计问题独立复核结论

针对第二轮交叉验收提出的 **3 项 P0 问题、6 项 P1 问题及 12 项测试补齐要求**，经逐行核对源码并编写前置失败复现脚本（`tests/round2-red-baseline.js`）在 `a0a5ccc` 基线上实测验证：

1. **8 项问题（P0-1、P0-2、P0-3、P1-4、P1-5、P1-6、P1-8、P1-9）完全属实**；
2. **1 项问题（P1-7 最终报价利润校验）部分属实**：`js/fg-core.js` 在第一轮已实现按对外展示精度舍入后的实际利润重算（`fobProfitRmb` / `cifProfitRmb`），但确实缺少**公司最低利润率底线（Margin Floor）自动校验与阻断机制**，已在第二轮补齐。
3. **本轮严格遵守范围纪律**：未扩大第一阶段功能范围、未进行大规模架构重构、未引入任何构建工具链、未删除任何既有业务功能。

---

## 二、先红后绿（Red-to-Green）确定性复现与修复台账

所有 9 项新增问题均遵循 **「先在 `a0a5ccc` 上运行 `tests/round2-red-baseline.js` 捕获全 `false` 证据 → 实施最小化精准修复 → 复跑验证全 `true`」** 的闭环流程：

- 修复前红灯快照：[`docs/qa/evidence/round2-pre-fix-red.json`](./evidence/round2-pre-fix-red.json)（捕获时间：`2026-11-26T09:48:27.251Z`，9 项断言全部为 `false`）
- 修复后绿灯快照：[`docs/qa/evidence/round2-post-fix-green.json`](./evidence/round2-post-fix-green.json)（捕获时间：`2026-11-26T10:15:12.386Z`，9 项断言全部为 `true`）
- 第一轮 16 项历史问题回归验证：`tests/red-baseline-proof.js` 全部 `16 / 16` 保持 `true` 无回退。

| 编号 | 问题摘要 | 修复前 (`a0a5ccc`) | 修复后 (`Round 2`) | 核心修复点与代码位置 |
| --- | --- | :---: | :---: | --- |
| **P0-1** | 多标签页并发保存客户覆盖与软删除复活风险 | `false` (`🔴`) | `true` (`🟢`) | `js/fg-store.js` 新增单事务增量合并写入 `putLeadMerged` 与增量比对 `syncActiveLeads`；`js/fg-core.js` `mergeLeadRecord` 增加单调递增 `_rev` 与 `respectExistingSoftDelete` 软删除保护（后台旧标签页无法复活已删客户，且不丢并发跟进记录）；`index.html` 单客户改动统一走 `saveSingleLead` `O(1)` 增量持久化。 |
| **P0-2** | 外部 JSON 完整备份缺回收站且恢复缺合规台账 | `false` (`🔴`) | `true` (`🟢`) | `index.html` 新增 `buildFullBackupPayload`（`schemaVersion: 2`，含 `crmLeads`、`crmTrash`、`complianceLogs`、`compareList`、`defaultOwner`、`deviceTag`）与 `restoreFullBackupPayload`；`js/fg-store.js` `restoreBackupBundle`、`createSnapshot`、`restoreSnapshot` 全量覆盖回收站与合规台账；下载提示改为诚实表述「已触发下载……请在浏览器下载栏确认外部文件已安全落盘」。 |
| **P0-3** | IndexedDB 旧数据迁移异常静默跳过与完成标记时机 | `false` (`🔴`) | `true` (`🟢`) | `js/fg-store.js` `api.init` 对 `friesgo_leads_v2` / `friesgo_trash_v1` / `friesgo_follow` 执行严格 `JSON.parse` 校验，损坏 JSON 立即抛错中止且绝不删除原始键；实行四阶段提交（写入并标 `in_progress` → 独立回读核验条数/嵌套时间线/报价/ID 集合 → 校验通过后才写入 `verified` 与 `migratedAt` → 清理旧运行态键并保留 `_backup_pre_p1`）。 |
| **P1-4** | 初步参考报价（Indicative）与正式报价（Formal）分离 | `false` (`🔴`) | `true` (`🟢`) | `index.html` `evaluateQuoteDdGate` 划分为三级：`approved`（主体+制裁必查通过且主体未变更）解锁 `Formal Quotation`；未关联客户/背调待审/主体变更导致背调失效仅允许生成明确标注 `Indicative Quotation (For Reference Only / Non-Binding)` 的初步参考报价；`blocked`（禁止交易）与 `review`（存疑待审）全入口硬锁定，不可通过切换报价类型绕过风控。 |
| **P1-5** | 多件不可拆卸重货装柜离散分配校验（`5×9t` 限重 `26t`） | `false` (`🔴`) | `true` (`🟢`) | `js/fg-core.js` `computeContainerLoad` 新增轻量级多约束离散 `packDiscreteFFD`（First-Fit Decreasing，同时校核单柜限重、实装容积与 `noStack` 柜底占底面积），`5 台 × 9 吨 = 45 吨`（单柜限重 `26 吨`）准确判定每柜最多装 2 台（`18t ≤ 26t`，`3×9t=27t > 26t`），推荐 **`3 × 20'GP`**。 |
| **P1-6** | 跨标签页、跨设备与清缓存场景下报价编号唯一性及版本管理 | `false` (`🔴`) | `true` (`🟢`) | 严格分离内部不可变唯一主键 `quoteId`、对外报价单号 `refNo`（`FG-YYYYMMDD-{CLIENT}-{DEV4}-{SEQ}-V{VER}`）与版本号 `ver`（`V1/V2...`）；`js/fg-store.js` 将 4 位设备标识 `device_tag` 与每日流水号 `qseq_YYYYMMDD` 持久化在 IndexedDB `meta` 表并通过 `reserveNextQuoteSeq` 原子递增 + `BroadcastChannel` 广播，清除 `localStorage` 不会重置流水号。 |
| **P1-7** | 对外精度舍入后最终实际利润底线校验 | `false` (`🔴`) | `true` (`🟢`) | `index.html` 报价器新增 `#qcMinMarginFloor`（默认 `8%`）与 `#qcProfitFloorWarn` 预警横幅；`js/fg-core.js` `computeQuote` 在单价、总价、佣金、保费全部按对外精度舍入后复核实际利润率，若跌破公司底线或为负（`belowProfitFloor: true`）则高亮告警并阻断对外报价生成/复制/归档，同时在一般纳税人退税模式下提示 `0%` 退税保守口径亏损风险（`conservativeNegativeWarn`）。 |
| **P1-8** | Google Maps 团队配额治理、直连独立计费警示与生产环境禁绕过 | `false` (`🔴`) | `true` (`🟢`) | `index.html` `#gmapsCfgBox` 将 Worker 代理明确标为「方式 A：公司正式统一模式」，并为「方式 B：个人直连 API Key」新增常驻 `#gmapsDirectBillingWarn` 警示（明确提示走个人账户独立计费、不受团队服务端额度控制）；`workers/gmaps-proxy.js` 在 `ENVIRONMENT === "production"` 时强制禁用 `ALLOW_UNMETERED_DEV` 绕过开关（无 `QUOTA_LIMITER` 一律 `503` Fail-Closed），并输出 `X-Quota-Mode` 审计响应头。 |
| **P1-9** | 合规台账交易/订单级绑定、勾选进度与审核结论分离及高风险强校验 | `false` (`🔴`) | `true` (`🟢`) | `index.html` `#precheck` 新增必填 `#pcOrderRef`（订单/PI/合同号，支持同一客户多笔订单独立留痕）、`#pcEvidence`（佐证编号）及显式 `#pcDecision`（待审核 / 审核放行 / 退回补证 / 高危拦截）；`6/6` 勾选仅代表核查项完成度，不自动等同于审核放行；高风险/转口关注国（命中 `COMP[country]` 等）及设为「审核放行」的订单强制要求填妥最终用户用途与佐证来源。 |

---

## 三、12 项测试补齐执行结果与实测数据

### 1 & 2 & 3. CRM 10,000 条与 CSV 10,000 条压测、分项耗时及分页 DOM 上限验证

实测脚本：`tests/full-audit-suite.js`（Part F）及 `tests/e2e-and-stress.js`（Step 9），运行环境：macOS Headless Chromium (`1440×920`)。

| 压测模块与数据规模 | 数据库写入耗时 (`dbWriteMs`) | 数据库查询耗时 (`dbQueryMs`) | 首屏渲染耗时 (`firstScreenRenderMs`) | 筛选/搜索重绘耗时 (`filterRerenderMs`) | 设定 DOM 行数上限 | 实测渲染 DOM 行数 | 结论 |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **CRM 客户库（10,000 条有效客户）** | `273 ms` | `27 ms` | `37 ms` | `26 ms`（全量精准检索 + 国家筛选） | `#followBody` `≤ 200` 行 | **`200` 行** | ✅ 通过 |
| **CRM 回收站（120 条软删除记录）** | 含于事务 | 含于事务 | `< 10 ms` | `< 10 ms` | `#crmTrashBox` `≤ 50` 条/页 | **`50` 条** | ✅ 通过 |
| **CSV 导入洗名单（10,000 条原始线索）** | 内存会话态（解析+去重含于首屏） | N/A | `37 ms`（含 10,000 行解析+跨国去重+首屏渲染） | `18 ms`（切换排除货代/疑似货代/全部） | `#csvTbody` `≤ 500` 行 | **`500` 行** | ✅ 通过 |

### 4. 双标签页真实并发冲突矩阵测试（`multiTabConflictMatrix`）

在同一浏览器存储实例下开启两个真实 CDP 页面标签（`Tab A` 与 `Tab B`）并发操作同一客户 `ld_race_target`（`Monterrey Heavy Machinery S.A.`）：

1. **并发追加跟进 + 修改不同字段**：`Tab A` 修改联系人 `Ing. Roberto Garza` 并追加电话跟进，同时 `Tab B` 修改官网 `https://mhm.mx` 并追加 WhatsApp 跟进 → 最终库内两个字段及两条跟进时间线 **100% 并集保留**，零覆盖丢失。
2. **并发归档报价 + 清除 `localStorage` 流水号防撞**：`Tab A` 与 `Tab B` 同时点击「归档报价版本」，随后清空 `localStorage` 再归档第 3 份报价 → 生成 3 个唯一内部 `quoteId` 及 3 个连续不重复的设备级单号（`FG-20261126-MONTER-KKWY-001-V1`、`FG-20261126-MONTER-KKWY-002-V1`、`FG-20261126-MONTER-KKWY-003-V3`）。
3. **并发软删除防复活保护**：`Tab A` 将客户移入回收站，同时 `Tab B` 持旧内存活跃副本提交延迟跟进记录 `tl_stale_b` → 客户在库内**严格保持软删除状态**（`inActive: false, stayedInTrash: true`），不会复活回活跃列表，且 `Tab B` 提交的跟进记录安全合并留存于回收站档案中（`keptTabBLateTimeline: true`）。
4. **跨标签页恢复同步**：`Tab A` 从回收站点击恢复后，`Tab B` 通过 `BroadcastChannel` 自动实时同步恢复该客户（`restoredInTabB: true`）。

### 5. 全量业务数据导出与跨浏览器（全新空白实例）恢复验证

- 从浏览器实例 1（`profileDir1`）调用 `buildFullBackupPayload()` 导出完整 JSON（含有效客户、报价历史 `V1/V2`、7 条跟进记录、已失效背调记录、1 条软删除回收站客户、同一客户名下 2 笔不同订单号 `PI-2026-MX-001` / `PI-2026-MX-002` 的合规台账、3 国对比列表及默认负责人）。
- 启动完全独立的**第二个全新浏览器实例（`profileDir2`，初始库为 `0` 条）**执行 `restoreFullBackupPayload` 并刷新页面复核：有效客户、回收站、报价版本、跟进历史、2 笔订单级合规台账、`compareList` 与 `defaultOwner` **100% 完整一致恢复**。
- 本地事务快照验证：创建快照后删除合规记录再执行 `restoreSnapshot`，验证合规台账随客户与回收站一并原子回滚恢复（`snapComplianceCount: 2 → complianceRestoredCount: 2`）。

### 6. 完整 20 步外贸业务全链路 E2E 逐步断言结果

| 步骤 | 业务环节描述 | 关键断言结果 | 状态 |
| :---: | --- | --- | :---: |
| 01 | 今日工作台首屏渲染与默认负责人（`李外贸总监`）持久化 | `active: true, owner: "李外贸总监"` | ✅ |
| 02 | 今日商机情报源健康度与分类筛选切换 | `更新：2026-11-26 13:17 北京时间` | ✅ |
| 03 | 146 国市场速查检索（越南工业品与关税口径） | `foundVietnam: true` | ✅ |
| 04 | 多国并排对比矩阵（越南 / 沙特 / 墨西哥） | `hasAll3: true` | ✅ |
| 05 | 地图找客户引擎切换及直连 API Key「独立计费·不受团队服务端额度控制」警示 | `hasIndependentBillingWarn: true` | ✅ |
| 06 | 海外精准搜客语法生成（墨西哥工业买家 6 大渠道） | `dorkLinksCount: 6` | ✅ |
| 07 | CSV 批量清洗：分机号剥离、意大利固话保 `0`、跨国同名保留、疑似货代一键剔除 | `beforePurge: 4 → afterPurge: 3, extClean: true, italyZeroKept: true` | ✅ |
| 08 | 从 CSV 清洗台一键建档推入 IndexedDB 客户库 | `crmCount: 1, company: "Delta Industrial Valve Co."` | ✅ |
| 09 | 采购决策人企业邮箱格式推演（8 种企业邮箱组合） | `carlos.mendez@deltavalve.mx` 等生成正常 | ✅ |
| 10 | 实时汇率扣除 `0.08` 结汇安全缓冲后一键同步至报价器 | `syncedFx: 6.6` | ✅ |
| 11 | 未完成背调客户在报价器试算仅生成 `Indicative Quotation`（严禁出现 Formal 字样） | `quoteTier: "indicative", noFormalLeak: true` | ✅ |
| 12 | 舍入后实际利润率低于公司底线（`8% < 15%`）触发红框告警并阻断报价按钮 | `floorBlocked: true` | ✅ |
| 13 | 客户背调设为「🔴 禁止交易」后全链路硬锁定（不可切 Indicative 绕过） | `tierWhenBlocked: "locked", btnDisabled: true` | ✅ |
| 14 | 完成工商存续 + 制裁必查并由风控主管显式审批为「🟢 审核通过」 | `ddDecisionSaved: "approved"` | ✅ |
| 15 | 装柜试算：`5 台 × 9 吨`（单柜限重 `26 吨`）FFD 离散配重分柜推荐 `3 × 20'GP` | `rec: "3 × 20'GP 小柜（重货按不可拆单元离散配重分柜）"` | ✅ |
| 16 | 背调通过客户解锁 `Formal Quotation`（带入 `3 x 20'GP` 装箱参数）并归档 `V1`/`V2` 唯一单号 | `FG-20261126-DELTAI-KKWY-004-V1` / `005-V2` | ✅ |
| 17 | 多语种（西语）21 天节奏开发信生成与 10 大高频异议救场话术验证 | `hasSpanishOrProdEmail: true, objCards: 10` | ✅ |
| 18 | 出运合规台账：`6/6` 勾选与结论解耦、阿联酋缺终端用途阻断、同客户归档 2 笔独立订单号 | `PI-2026-MX-001 (approved)` + `PI-2026-MX-002 (rework)` | ✅ |
| 19 | 客户详情追加水单跟进；修改客户网站域名触发背调失效并自动将报价器从 `Formal` 降级回 `Indicative` | `staleNow: true, downgradedTier: "indicative"` | ✅ |
| 20 | 含有效客户、回收站与合规台账的事务快照创建、删除回滚与完整性核验 | `active: 1, trash: 1, complianceRestored: 2` | ✅ |

*(注：在执行第 19 步自动化验收时，真实捕获并修复了 `renderQuoteDdGateUI` 在客户域名变更后未同步刷新 `_lastQuoteState.quoteTier` 的状态同步缺陷。)*

### 7. 全部 33 个路由视图与 41 个 DOM 模块容器交互测试

- 不仅验证页面渲染，还在 `tests/full-audit-suite.js`（Part E）中对全部 **33 个路由键值**及全部 **41 个视图容器**（40 个 `<section>` + `#panel-market`）执行了真实按钮点击、下拉筛选、滑块调节、币种互换、地图口径切换与跨模块带参跳转。
- 结果：`containersVerified: 41 / 41` 全部可见且内容非空，18 组跨模块交互断言全部 `true`，全程未捕获任何 JS 运行时异常或 `console.error`（`runtimePageErrors: []`）。

---

## 四、跨端兼容、Cloudflare Worker 部署核查与客观环境边界声明（QA 8、QA 9、P1-8）

本着工程诚实原则，对自动化验证覆盖范围及外部基础设施状态如实披露如下：

### 1. Safari / WebKit 与移动端测试状态（QA 8）
- **移动端触屏视口实测（已通过 ✅）**：通过 CDP 设备仿真在 `390 × 844`（`DPR = 3, mobile = true, touch = true`）下完成今日工作台与报价计算器交互验证，实测页面横向 `scrollWidth ≤ 390px`（零横向溢出），移动端工作区切换与表单控件响应正常（见截图 `06-mobile-390x844-quote-view.png`）。
- **macOS Safari / WebKit 实机驱动探测（受系统权限门禁限制 ⚠️ 如实标记）**：本机存在 `/System/Cryptexes/App/usr/bin/safaridriver`，审计脚本实际发起 WebDriver 会话探测，返回苹果系统级权限提示：
  > `HTTP 500: Could not create a session: You must enable 'Allow remote automation' in the Developer section of Safari Settings to control Safari via WebDriver.`
  由于开启 Safari「允许远程自动化」须本机用户在 macOS 图形界面手动输入系统密码/TouchID 授权，当前命令行沙箱无法代为开启；同时物理 iOS / Android 真机亦未接入当前本地测试机，**特此如实标记为待人工真机/Safari 抽检项**（前端代码全部采用标准 ES2020、`BigInt`、`IndexedDB` 与 `BroadcastChannel`，Safari 15.4+ 均原生支持）。

### 2. Cloudflare Worker 服务端代理真实部署状态核查（P1-8）
- **仓库代码与本地高并发验证（已完成 ✅）**：
  - [`workers/gmaps-proxy.js`](../../workers/gmaps-proxy.js) 与 [`wrangler.toml`](../../wrangler.toml) 已完整实现 `QuotaLimiter` Durable Object 单实例串行原子预扣（`700` 提醒 / `900` 预警 / `950` 硬上限）、`ALLOWED_ORIGIN` 校验、`TEAM_PASS` 鉴权、JSON 合法性前置校验（坏请求不扣额度）、无绑定 `503` Fail-Closed，以及 `ENVIRONMENT = "production"` 下强制禁止 `ALLOW_UNMETERED_DEV` 绕过。
  - `tests/unit-core-and-worker.test.js` 已通过 `50` 并发请求冲击 `920 / 950` 临界配额测试（精确放行 `30` 笔 `200 OK`、拦截 `20` 笔 `429`）及生产环境禁绕过测试。
- **云端生产部署状态（尚未部署至 Cloudflare 云端 ⚠️ 如实标记）**：
  - 当前本地环境未绑定团队 Cloudflare 账号凭证，且前端 `#msProxyUrl` 默认为空（未预置硬编码线上 Worker URL）。
  - **正式启用团队 Google Maps 采集前**，管理员须在团队 Cloudflare 账号下执行：
    ```bash
    npx wrangler deploy
    npx wrangler secret put GOOGLE_MAPS_API_KEY
    npx wrangler secret put TEAM_PASS
    ```
    并在 `wrangler.toml` 中确认 `ENVIRONMENT = "production"`（严禁配置 `ALLOW_UNMETERED_DEV`），随后将生成的 `https://<worker>.workers.dev` 与口令下发团队填入「方式 A」。在此之前，任何业务员若自行填入「方式 B：个人直连 API Key」，界面均常驻显示 `#gmapsDirectBillingWarn` 独立计费与不受团队额度管控警示。

### 3. GitHub Pages 线上版本一致性核验（QA 9）
- 当前全部整改提交位于本地分支 `fix/phase1-round2-audit`，尚未推送覆盖远端 `main`。
- 待用户确认合并推送 `origin/main` 后，将在 GitHub Pages 构建完成后立即抓取线上 `https://jasunmr389-ship-it.github.io/friesgo-market/` 的 `index.html`、`js/fg-core.js`、`js/fg-store.js` SHA-256 摘要与本地 `main` 分支逐字节比对确认一致。

---

## 五、归档证据清单（`docs/qa/evidence/`）

1. **自动化执行结果结构化报告**：[`docs/qa/evidence/audit-execution-results.json`](./evidence/audit-execution-results.json)
2. **第二轮先红后绿基线快照**：
   - 修复前（全红）：[`docs/qa/evidence/round2-pre-fix-red.json`](./evidence/round2-pre-fix-red.json)
   - 修复后（全绿）：[`docs/qa/evidence/round2-post-fix-green.json`](./evidence/round2-post-fix-green.json)
3. **全套测试真实终端执行日志**：
   - 第二轮全量审计日志：[`docs/qa/evidence/full-audit-execution.log`](./evidence/full-audit-execution.log)
   - 全套 5 组测试运行器汇总日志：[`docs/qa/evidence/all-suites-execution.log`](./evidence/all-suites-execution.log)
4. **无头浏览器真实运行截图**：
   - 首屏与工作区导航：[`docs/qa/evidence/01-home-and-navigation.png`](./evidence/01-home-and-navigation.png)
   - 正式报价单与最低利润底线守卫：[`docs/qa/evidence/02-quote-formal-and-profit-guard.png`](./evidence/02-quote-formal-and-profit-guard.png)
   - `5 台 × 9 吨` 不可拆重货 FFD 分柜（推荐 `3 × 20'GP`）：[`docs/qa/evidence/03-container-5x9t-ffd.png`](./evidence/03-container-5x9t-ffd.png)
   - 订单级（`#pcOrderRef`）合规核查与结论分离台账：[`docs/qa/evidence/04-precheck-order-compliance-ledger.png`](./evidence/04-precheck-order-compliance-ledger.png)
   - `10,000` 条 CRM 客户库分页窗口化渲染（DOM 严格控在 200 行）：[`docs/qa/evidence/05-crm-10k-windowed-dom.png`](./evidence/05-crm-10k-windowed-dom.png)
   - 移动端 `390 × 844` 视口无溢出实测截图：[`docs/qa/evidence/06-mobile-390x844-quote-view.png`](./evidence/06-mobile-390x844-quote-view.png)
