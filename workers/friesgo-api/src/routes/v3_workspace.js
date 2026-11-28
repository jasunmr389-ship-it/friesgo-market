// FriesGo Global V3.0 Slice 1 - Multi-Tenant Authenticated Workspace Routes
// Implements:
//   - REV01: Strict org logical isolation (X-FG-Org-Id, zero silent fallback, user-granted support_access_grants)
//   - REV09: Application review & separated activation (partner / tool_trial / team_career)
//   - NEW01: Approved product catalog & verified certifications management
//   - ACQ01-12: Platform-agnostic manual social discovery (FB/IG/LI + YouTube future), 4-tier signals,
//               explainable tags, dedupe, audit, reply draft vs confirmed manual send, source comparison
//   - UX02-05 / REV07-08: Today's action queue + Personal WeChat desensitized cards, Projects & buyer roles,
//                         3-tier blind-dedupe Deal Reg, intake receipt vs protection record
//   - ENG01: Atomic D1 DB.batch() with op_id conditional side-effect proof + strong idempotency after requireAuth
//   - ENG03: Auth-proxied attachments (zero unauthenticated presigned URLs; immediate 401 on session revoke)

import { requireAuth, resolveTenantContext, runIdempotentOperation } from "../auth.js";
import { base64ToBytes, bytesToBase64, hashPassword, randomHex, randomId, sha256Hex } from "../crypto.js";
import { formatMinor, getCurrencySpec, parseExactSafeIntBigInt } from "../money.js";
import {
  addDaysIso,
  addSecondsIso,
  extractCleanDomain,
  isPublicOrPlatformDomain,
  json,
  monotonicOptOut,
  normalizeCompanyName,
  nowIso,
  parseJsonBody,
  redactPii,
  safeJsonParse,
  writeAuditLog,
} from "../utils.js";

const VALID_TASK_PLATFORMS = new Set(["facebook", "instagram", "linkedin", "youtube", "website", "radar", "other"]);
const VALID_SIGNAL_PLATFORMS = new Set([
  "facebook",
  "instagram",
  "linkedin",
  "youtube",
  "website",
  "worldbank",
  "gdacs",
  "news",
  "manual_import",
  "other",
]);
const VALID_ACQ_MODES = new Set([
  "manual_discovery",
  "owned_account_inquiry",
  "owned_ad_form",
  "partner_referral",
  "radar_signal",
  "file_import",
]);
const VALID_SIGNAL_TIERS = new Set(["market_event", "potential_demand", "verified_opportunity", "direct_inquiry"]);
const VALID_AUDIT_STATUSES = new Set([
  "pending_verify",
  "verified_valid",
  "approved",
  "duplicate",
  "expired",
  "seller_ad",
  "irrelevant",
  "rejected",
]);
const VALID_READINESS = new Set(["direct_supply", "needs_confirmation", "intelligence_only"]);
const VALID_BUYER_ROLES = new Set([
  "owner",
  "designer",
  "epc",
  "subcontractor",
  "importer",
  "distributor",
  "buyer",
  "unknown",
]);
const VALID_REG_TIERS = new Set(["relationship_reg", "demand_reg", "project_reg"]);
const VALID_QUOTE_TIERS = new Set(["indicative", "official", "formal"]);
const VALID_INCOTERMS = new Set(["EXW", "FCA", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"]);
const VALID_ATTACH_ENTITY_TYPES = new Set(["demand_signal", "deal_registration", "inquiry", "company", "project", "application"]);

function isManagerRole(ctx) {
  return ctx.role === "super_admin" || ctx.role === "manager";
}

function isInternalRole(ctx) {
  return ctx.role === "super_admin" || ctx.role === "manager" || ctx.role === "staff";
}

function isPartnerRole(ctx) {
  return ctx.role === "partner_followup" || ctx.role === "partner_referrer";
}

function rejectReadOnlySupport(ctx, method, cors) {
  if (ctx.role === "support_readonly" && method !== "GET") {
    return json(
      { ok: false, code: "SUPPORT_GRANT_READ_ONLY", error: "当前处于受限只读排障授权模式，禁止写入目标独立空间数据" },
      403,
      cors
    );
  }
  return null;
}

/**
 * S03: Enforce signal-level access control for partners (must be creator, referrer, or active assignee).
 */
async function canActorAccessSignal(db, ctx, actorId, sig) {
  if (!sig || sig.org_id !== ctx.orgId) return false;
  if (!isPartnerRole(ctx)) return true;
  if (sig.created_by === actorId || sig.referrer_employee_id === actorId) return true;
  const asg = await db
    .prepare(
      `SELECT 1 AS ok FROM lead_assignments
       WHERE org_id = ? AND signal_id = ? AND primary_assignee_id = ? AND assignment_status IN ('pending_accept','accepted')
       LIMIT 1`
    )
    .bind(ctx.orgId, sig.id, actorId)
    .first();
  return Boolean(asg);
}

/**
 * S04: Enforce partner entity-level access control for attachments (visibility + parent entity ownership/assignment).
 */
async function canPartnerAccessEntity(db, ctx, actorId, entityType, entityId) {
  if (!entityId) return false;
  if (entityType === "demand_signal") {
    const sig = await db.prepare("SELECT * FROM demand_signals WHERE id = ? AND org_id = ?").bind(entityId, ctx.orgId).first();
    return Boolean(sig && (await canActorAccessSignal(db, ctx, actorId, sig)));
  }
  if (entityType === "deal_registration") {
    const r = await db
      .prepare("SELECT 1 AS ok FROM deal_registrations WHERE id = ? AND org_id = ? AND partner_employee_id = ? LIMIT 1")
      .bind(entityId, ctx.orgId, actorId)
      .first();
    return Boolean(r);
  }
  if (entityType === "inquiry") {
    const r = await db
      .prepare(
        `SELECT 1 AS ok FROM inquiries
         WHERE id = ? AND org_id = ?
           AND (referrer_employee_id = ? OR primary_owner_id = ? OR id IN (
             SELECT inquiry_id FROM lead_assignments
             WHERE org_id = ? AND primary_assignee_id = ? AND assignment_status IN ('pending_accept','accepted') AND inquiry_id != ''
           ))
         LIMIT 1`
      )
      .bind(entityId, ctx.orgId, actorId, actorId, ctx.orgId, actorId)
      .first();
    return Boolean(r);
  }
  if (entityType === "company") {
    const r = await db
      .prepare(
        `SELECT 1 AS ok FROM companies
         WHERE id = ? AND org_id = ? AND deleted_at IS NULL
           AND (primary_owner_id = ? OR source_contributor_id = ? OR id IN (
             SELECT company_id FROM lead_assignments
             WHERE org_id = ? AND primary_assignee_id = ? AND assignment_status IN ('pending_accept','accepted') AND company_id != ''
           ))
         LIMIT 1`
      )
      .bind(entityId, ctx.orgId, actorId, actorId, ctx.orgId, actorId)
      .first();
    return Boolean(r);
  }
  if (entityType === "project") {
    const r = await db
      .prepare(
        `SELECT 1 AS ok FROM projects
         WHERE id = ? AND org_id = ?
           AND (created_by = ? OR primary_owner_id = ? OR id IN (
             SELECT project_id FROM lead_assignments
             WHERE org_id = ? AND primary_assignee_id = ? AND assignment_status IN ('pending_accept','accepted') AND project_id != ''
           ))
         LIMIT 1`
      )
      .bind(entityId, ctx.orgId, actorId, actorId, ctx.orgId, actorId)
      .first();
    return Boolean(r);
  }
  return false;
}

async function canActorAccessAttachment(db, ctx, actorId, att) {
  if (!att || att.org_id !== ctx.orgId) return false;
  if (!isPartnerRole(ctx)) return true;
  if (att.uploaded_by === actorId) return true;
  if (String(att.visibility || "internal_only") !== "org_authorized") return false;
  return canPartnerAccessEntity(db, ctx, actorId, att.entity_type, att.entity_id);
}

/**
 * S05: Authoritative opt-out / compliance lock check for BOTH unlinked and company-linked signals.
 */
async function checkSignalOptOutState(db, ctx, sig) {
  const signalOptedOut = Number(sig.opt_out_locked || 0) === 1 || sig.contact_result === "opted_out";
  let companyOptOutStatus = "none";
  let complianceBlocked = false;
  if (sig.linked_company_id) {
    const cmp = await db
      .prepare("SELECT opt_out_status, compliance_status FROM companies WHERE id = ? AND org_id = ?")
      .bind(sig.linked_company_id, ctx.orgId)
      .first();
    if (cmp) {
      companyOptOutStatus = cmp.opt_out_status || "none";
      complianceBlocked = cmp.compliance_status === "blocked";
    }
  }
  return {
    blocked: signalOptedOut || companyOptOutStatus !== "none" || complianceBlocked,
    signalOptedOut,
    companyOptOutStatus,
    complianceBlocked,
  };
}

/**
 * N02: Strict task spend & currency validator (rejects fractional/negative/unsafe integers and missing/unknown currencies).
 */
function parseTaskSpendStrict(actualSpendRaw, currencyRaw, fallbackCurrency = "") {
  if (actualSpendRaw === null || actualSpendRaw === undefined || actualSpendRaw === "") {
    const cleanCur = String(currencyRaw ?? fallbackCurrency ?? "").trim().toUpperCase().slice(0, 10);
    return { ok: true, minor: null, currency: cleanCur };
  }
  let minorBig;
  try {
    minorBig = parseExactSafeIntBigInt(actualSpendRaw, "actual_spend_minor", { allowNegative: false });
  } catch (err) {
    return { ok: false, code: "INVALID_SPEND_AMOUNT", error: `投入金额 actual_spend_minor 须为非负精确最小货币单位整数：${err.message}` };
  }
  const curCode = String(currencyRaw ?? fallbackCurrency ?? "").trim().toUpperCase();
  if (!curCode) {
    return { ok: false, code: "SPEND_CURRENCY_REQUIRED", error: "登记实际投入金额时必须明确币种 spend_currency（如 USD/CNY/JPY）" };
  }
  let spec;
  try {
    spec = getCurrencySpec(curCode);
  } catch {
    return { ok: false, code: "INVALID_SPEND_CURRENCY", error: `不支持的币种 ${curCode}（仅支持 USD/CNY/EUR/GBP/JPY/AED/SAR）` };
  }
  return { ok: true, minor: Number(minorBig), currency: spec.code };
}

/**
 * N04: Strict half-open date window parser (bare YYYY-MM-DD interpreted in UTC+8 by default so same-day to=YYYY-MM-DD includes entire day).
 */
function parseDateWindow(fromRaw, toRaw, tzOffsetRaw) {
  let tzOffsetMinutes = 480; // Default Asia/Shanghai / Asia/Singapore (UTC+8)
  if (tzOffsetRaw !== undefined && tzOffsetRaw !== null && String(tzOffsetRaw).trim() !== "") {
    const n = Number(tzOffsetRaw);
    if (!Number.isInteger(n) || n < -720 || n > 840) {
      return { ok: false, code: "INVALID_DATE_RANGE", error: "时区偏移 tz_offset_minutes 须为 -720 至 840 之间的整数分钟" };
    }
    tzOffsetMinutes = n;
  }

  function parseDateBoundary(raw, isEnd) {
    if (!raw) return { ok: true, iso: null, ms: null, exclusive: false };
    const bare = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (bare) {
      const y = Number(bare[1]);
      const m = Number(bare[2]);
      const d = Number(bare[3]);
      const check = new Date(Date.UTC(y, m - 1, d));
      if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
        return { ok: false, error: `日期 ${raw} 不存在` };
      }
      const utcMs = Date.UTC(y, m - 1, isEnd ? d + 1 : d) - tzOffsetMinutes * 60000;
      return { ok: true, iso: new Date(utcMs).toISOString(), ms: utcMs, exclusive: isEnd };
    }
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) {
      return { ok: false, error: `日期时间格式无效：${raw}（请使用 YYYY-MM-DD 或 ISO-8601）` };
    }
    return { ok: true, iso: new Date(ms).toISOString(), ms, exclusive: false };
  }

  const start = parseDateBoundary(fromRaw, false);
  if (!start.ok) return { ok: false, code: "INVALID_DATE_RANGE", error: start.error };
  const end = parseDateBoundary(toRaw, true);
  if (!end.ok) return { ok: false, code: "INVALID_DATE_RANGE", error: end.error };

  if (start.ms !== null && end.ms !== null) {
    if ((end.exclusive && start.ms >= end.ms) || (!end.exclusive && start.ms > end.ms)) {
      return { ok: false, code: "INVALID_DATE_RANGE", error: `无效日期区间：起始时间 (${fromRaw}) 晚于截止时间 (${toRaw})` };
    }
  }

  return {
    ok: true,
    tzOffsetMinutes,
    fromRaw: fromRaw || null,
    toRaw: toRaw || null,
    startIsoUtc: start.iso,
    endIsoUtc: end.iso,
    endExclusive: end.exclusive,
    matches(tsStr) {
      if (start.ms === null && end.ms === null) return true;
      const ms = Date.parse(String(tsStr || ""));
      if (!Number.isFinite(ms)) return false;
      if (start.ms !== null && ms < start.ms) return false;
      if (end.ms !== null) {
        if (end.exclusive ? ms >= end.ms : ms > end.ms) return false;
      }
      return true;
    },
  };
}

/**
 * ACQ05: Deterministic, explainable demand signal triage (works 100% with AI off; never outputs opaque black-box scores).
 */
function buildExplainableJudgment({ demandSummary, countryEn, productLine, buyerRole, publishedAt, contactChannel, sourceUrl }) {
  const txt = String(demandSummary || "").toLowerCase();
  const missing = [];
  if (!countryEn) missing.push("country_en");
  if (!productLine || productLine === "unspecified") missing.push("product_line");
  if (!buyerRole || buyerRole === "unknown") missing.push("buyer_role");
  if (!publishedAt) missing.push("published_at");
  if (!contactChannel) missing.push("contact_channel");
  if (!/\d/.test(txt)) missing.push("quantity_or_spec_numbers");

  const sellerHints = /(we supply|factory direct|manufacturer in china|wholesale price|moq\s*\d|dm us for price|whatsapp us for catalog)/i;
  const buyerHints = /(looking for|need supplier|rfq|request for quotation|tender|project requirement|need distributor|seeking manufacturer|procurement|询价|采购|求购|招标)/i;
  const hasSpecHints = /(dn\d+|pn\d+|sdr\d+|hdpe|pe100|kv|mm2|xlpe|astm|api\s*6|iso\s*\d|ton|tons|meter|meters|pcs)/i;

  let demandClarity = "partial_needs_clarification";
  const reasons = [];
  if (sellerHints.test(txt) && !buyerHints.test(txt)) {
    demandClarity = "suspected_seller_ad";
    reasons.push("文本包含典型卖方推销表述且缺乏买方采购意图，建议核实后归类为同行卖货广告");
  } else if (buyerHints.test(txt) && hasSpecHints.test(txt)) {
    demandClarity = "explicit_procurement_with_specs";
    reasons.push("包含明确采购意图词与基础规格/数量线索");
  } else if (buyerHints.test(txt)) {
    demandClarity = "explicit_intent_missing_specs";
    reasons.push("包含采购意图词，但缺少具体技术规格或数量，首轮沟通优先补齐规格");
  } else {
    reasons.push("未见明确采购关键词，暂标为待人工核实语境");
  }

  let timeliness = "unknown_publish_time";
  if (publishedAt) {
    const ageDays = (Date.now() - Date.parse(publishedAt)) / 86400000;
    if (!Number.isFinite(ageDays)) timeliness = "unknown_publish_time";
    else if (ageDays <= 14) timeliness = "fresh_within_14d";
    else if (ageDays <= 45) timeliness = "moderate_15_to_45d";
    else {
      timeliness = "stale_over_45d";
      reasons.push("原始发布时间已超过 45 天，核实前须确认是否仍在采购窗口内");
    }
  } else {
    reasons.push("原始发布时间未知（已保留 NULL，未编造时间），核实时请确认时效");
  }

  const buyerRoleConfidence =
    buyerRole && buyerRole !== "unknown"
      ? `declared_${buyerRole}_pending_verify`
      : "unverified_role";

  const nextQuestions = [];
  if (missing.includes("product_line") || missing.includes("quantity_or_spec_numbers")) {
    nextQuestions.push("请确认所需产品标准/规格型号及预估采购量（不知晓可由工程师协助选型）");
  }
  if (missing.includes("country_en")) {
    nextQuestions.push("请确认项目所在国家及目的港/交付地");
  }
  if (missing.includes("buyer_role")) {
    nextQuestions.push("请确认贵司在项目中的角色（业主/总包/分包/进口商/分销商）");
  }
  if (!sourceUrl) {
    nextQuestions.push("建议补充原始来源链接或允许留存的来源标识以便复核");
  }

  return {
    judgmentTags: {
      demandClarity,
      timeliness,
      buyerRoleConfidence,
      reasons,
      nextQuestions,
      aiUsed: false,
    },
    missingInfo: missing,
  };
}

/**
 * Helper: Execute an atomic D1 DB.batch() or SQLite transaction for assignment state change + conditional event insert.
 * ENG01 Proof: Side-effect event INSERT checks EXISTS(... WHERE id=? AND org_id=? AND last_op_id=?),
 * ensuring ONLY the winning operation that actually updated the parent row creates an event!
 */
async function executeAtomicBatch(db, stmts) {
  if (typeof db.batch === "function") {
    return db.batch(stmts);
  }
  const results = [];
  for (const s of stmts) {
    results.push(await s.run());
  }
  return results;
}

export async function handleV3WorkspaceRoutes(request, env, cors, url) {
  const path = url.pathname;
  const method = request.method;

  if (!path.startsWith("/api/v3/")) return null;

  // STEP 1: EVERY /api/v3/* route MUST authenticate live session FIRST (ENG01/ENG03: revoked sessions NEVER replay cached responses!)
  const auth = await requireAuth(request, env, cors);
  if (!auth.ok) return auth.response;

  // 1. GET /api/v3/me/contexts — list available org contexts for explicit frontend context switcher
  if (path === "/api/v3/me/contexts" && method === "GET") {
    const now = nowIso();
    const totalMemRow = await env.DB
      .prepare("SELECT COUNT(*) AS cnt FROM org_memberships WHERE employee_id = ?")
      .bind(auth.actor.id)
      .first();
    const totalMemCount = Number((totalMemRow && totalMemRow.cnt) || 0);

    const memRes = await env.DB
      .prepare(
        `SELECT m.id AS membership_id, m.org_id, m.role, m.can_finance_settle, m.partner_ref_code,
                m.partner_approved_title, m.lead_cap_inquiry, m.lead_cap_dev, m.status,
                o.org_type, o.name AS org_name
         FROM org_memberships m
         JOIN orgs o ON o.id = m.org_id
         WHERE m.employee_id = ? AND m.status = 'active' AND o.status = 'active'
         ORDER BY CASE o.org_type WHEN 'company_main' THEN 0 ELSE 1 END, m.created_at ASC`
      )
      .bind(auth.actor.id)
      .all();

    const contexts = (memRes.results || []).map((r) => ({
      membership_id: r.membership_id,
      org_id: r.org_id,
      org_type: r.org_type,
      org_name: r.org_name,
      role: r.role,
      can_finance_settle: Boolean(r.can_finance_settle) || r.role === "super_admin",
      partner_ref_code: r.partner_ref_code || "",
      partner_approved_title: r.partner_approved_title || "",
      lead_cap_inquiry: Number(r.lead_cap_inquiry || 5),
      lead_cap_dev: Number(r.lead_cap_dev || 15),
    }));

    // S02: Backward compatibility ONLY for legacy main-org internal staff with ZERO org_memberships rows of any status!
    // Once an account has ANY org_memberships row (even disabled), NEVER fall back to org_friesgo_main!
    if (totalMemCount === 0 && !contexts.length && ["super_admin", "manager", "staff"].includes(auth.actor.role)) {
      const mainOrg = await env.DB.prepare("SELECT id, org_type, name FROM orgs WHERE id = 'org_friesgo_main'").first();
      contexts.push({
        membership_id: "legacy_main",
        org_id: "org_friesgo_main",
        org_type: (mainOrg && mainOrg.org_type) || "company_main",
        org_name: (mainOrg && mainOrg.name) || "FriesGo Global",
        role: auth.actor.role,
        can_finance_settle: auth.actor.role === "super_admin",
        partner_ref_code: "",
        partner_approved_title: "",
        lead_cap_inquiry: 99,
        lead_cap_dev: 99,
      });
    }

    let supportGrants = [];
    if (auth.actor.role === "super_admin") {
      const gRes = await env.DB
        .prepare(
          `SELECT g.id, g.org_id, g.scope, g.reason, g.expires_at, o.name AS org_name, o.org_type
           FROM support_access_grants g
           JOIN orgs o ON o.id = g.org_id
           WHERE g.grantee_employee_id = ? AND g.revoked_at IS NULL AND g.expires_at > ? AND o.status = 'active'
           ORDER BY g.expires_at ASC`
        )
        .bind(auth.actor.id, now)
        .all();
      supportGrants = gRes.results || [];
    }

    return json(
      {
        ok: true,
        actor: {
          id: auth.actor.id,
          login_id: auth.actor.login_id,
          display_name: auth.actor.display_name,
          role: auth.actor.role,
        },
        contexts,
        supportGrants,
      },
      200,
      cors
    );
  }

  // STEP 2: Strict multi-tenant org context resolution for ALL remaining /api/v3/* endpoints (REV01)
  const ctx = await resolveTenantContext(request, env, auth, cors, { requireExplicitOrgHeader: true });
  if (!ctx.ok) return ctx.response;

  const roErr = rejectReadOnlySupport(ctx, method, cors);
  if (roErr) return roErr;

  // =========================================================================
  // 2. Support Access Grants (REV01: Independent trial user controls admin diagnostics)
  // =========================================================================
  if (path === "/api/v3/support-grants" && method === "GET") {
    const res = await env.DB
      .prepare(
        `SELECT id, org_id, granted_by_employee_id, grantee_employee_id, scope, reason, expires_at, revoked_at, created_at
         FROM support_access_grants
         WHERE org_id = ?
         ORDER BY created_at DESC LIMIT 30`
      )
      .bind(ctx.orgId)
      .all();
    return json({ ok: true, grants: res.results || [] }, 200, cors);
  }

  if (path === "/api/v3/support-grants" && method === "POST") {
    if (ctx.orgType !== "independent_trial" || ctx.role !== "independent_user") {
      return json(
        { ok: false, code: "FORBIDDEN_SUPPORT_GRANT", error: "仅独立空间所有者可向管理员签发限时只读排障授权" },
        403,
        cors
      );
    }
    const body = await parseJsonBody(request, 8192);
    const hours = Math.min(72, Math.max(1, Number(body.ttl_hours || 24) || 24));
    const reason = String(body.reason || "support_diagnostics").trim().slice(0, 200);
    let granteeId = String(body.grantee_employee_id || "").trim();
    if (!granteeId) {
      const sa = await env.DB
        .prepare("SELECT id FROM employees WHERE role = 'super_admin' AND status = 'active' ORDER BY created_at ASC LIMIT 1")
        .first();
      if (!sa) return json({ ok: false, code: "NO_SUPER_ADMIN", error: "未找到有效的系统管理员账号" }, 404, cors);
      granteeId = sa.id;
    } else {
      const sa = await env.DB
        .prepare("SELECT id FROM employees WHERE id = ? AND role = 'super_admin' AND status = 'active'")
        .bind(granteeId)
        .first();
      if (!sa) return json({ ok: false, code: "INVALID_GRANTEE", error: "仅允许向在职总负责人签发只读排障授权" }, 400, cors);
    }

    const now = nowIso();
    const expiresAt = addSecondsIso(hours * 3600);
    const grantId = randomId("sgr");
    await env.DB
      .prepare(
        `INSERT INTO support_access_grants (id, org_id, granted_by_employee_id, grantee_employee_id, scope, reason, expires_at, revoked_at, created_at)
         VALUES (?, ?, ?, ?, 'read_only_diagnostics', ?, ?, NULL, ?)`
      )
      .bind(grantId, ctx.orgId, auth.actor.id, granteeId, reason, expiresAt, now)
      .run();
    await writeAuditLog(env.DB, auth.actor, "SUPPORT_GRANT_CREATED", "support_grant", grantId, `org=${ctx.orgId} grantee=${granteeId} expires=${expiresAt}`);
    return json({ ok: true, grant: { id: grantId, org_id: ctx.orgId, grantee_employee_id: granteeId, scope: "read_only_diagnostics", expires_at: expiresAt } }, 201, cors);
  }

  const revokeGrantMatch = path.match(/^\/api\/v3\/support-grants\/([^/]+)$/);
  if (revokeGrantMatch && method === "DELETE") {
    if (ctx.orgType !== "independent_trial" || ctx.role !== "independent_user") {
      return json({ ok: false, code: "FORBIDDEN_SUPPORT_GRANT", error: "仅独立空间所有者可撤销排障授权" }, 403, cors);
    }
    const grantId = decodeURIComponent(revokeGrantMatch[1]);
    const now = nowIso();
    const res = await env.DB
      .prepare("UPDATE support_access_grants SET revoked_at = ? WHERE id = ? AND org_id = ? AND revoked_at IS NULL")
      .bind(now, grantId, ctx.orgId)
      .run();
    if (Number((res && res.meta && res.meta.changes) || 0) === 0) {
      return json({ ok: false, code: "GRANT_NOT_FOUND", error: "排障授权不存在或已撤销" }, 404, cors);
    }
    await writeAuditLog(env.DB, auth.actor, "SUPPORT_GRANT_REVOKED", "support_grant", grantId, `org=${ctx.orgId}`);
    return json({ ok: true, revoked: true, id: grantId }, 200, cors);
  }

  // =========================================================================
  // 3. Strictly Org-Scoped Companies (REV01 isolation + Partner least privilege)
  // =========================================================================
  if (path === "/api/v3/companies" && method === "GET") {
    const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
    let rows = [];
    if (isPartnerRole(ctx)) {
      const res = await env.DB
        .prepare(
          `SELECT id, org_id, canonical_name, country_en, city, website_domain, buyer_type, product_summary,
                  opt_out_status, compliance_status, derived_contact_status, primary_owner_id, source_contributor_id, updated_at
           FROM companies
           WHERE org_id = ? AND deleted_at IS NULL AND merged_into_id IS NULL
             AND (
               primary_owner_id = ?
               OR source_contributor_id = ?
               OR id IN (
                 SELECT company_id FROM lead_assignments
                 WHERE org_id = ? AND primary_assignee_id = ? AND assignment_status IN ('pending_accept','accepted') AND company_id != ''
               )
             )
           ORDER BY updated_at DESC LIMIT 200`
        )
        .bind(ctx.orgId, auth.actor.id, auth.actor.id, ctx.orgId, auth.actor.id)
        .all();
      rows = res.results || [];
    } else {
      const res = await env.DB
        .prepare(
          `SELECT id, org_id, canonical_name, country_en, city, website_domain, google_place_id, buyer_type, product_summary,
                  opt_out_status, compliance_status, derived_contact_status, primary_owner_id, source_contributor_id, updated_at
           FROM companies
           WHERE org_id = ? AND deleted_at IS NULL AND merged_into_id IS NULL
           ORDER BY updated_at DESC LIMIT 200`
        )
        .bind(ctx.orgId)
        .all();
      rows = res.results || [];
    }
    if (q) {
      rows = rows.filter(
        (r) =>
          String(r.canonical_name || "").toLowerCase().includes(q) ||
          String(r.country_en || "").toLowerCase().includes(q) ||
          String(r.website_domain || "").toLowerCase().includes(q)
      );
    }
    return json({ ok: true, orgId: ctx.orgId, companies: rows }, 200, cors);
  }

  if (path === "/api/v3/companies" && method === "POST") {
    if (isPartnerRole(ctx)) {
      return json({ ok: false, code: "FORBIDDEN_PARTNER_DIRECT_POOL", error: "外部伙伴请通过客户报备入口提交客户，不可直接写入公司主公海池" }, 403, cors);
    }
    const body = await parseJsonBody(request, 32768);
    const canonicalName = String(body.canonical_name || body.company_name || "").trim();
    const countryEn = String(body.country_en || body.country || "").trim();
    if (!canonicalName || !countryEn) {
      return json({ ok: false, code: "COMPANY_FIELDS_REQUIRED", error: "企业名称与国家为必填项" }, 400, cors);
    }
    const normName = normalizeCompanyName(canonicalName);
    const website = String(body.website || "").trim();
    const dom = extractCleanDomain(body.website_domain || website);
    const websiteDomain = isPublicOrPlatformDomain(dom) ? "" : dom;
    const googlePlaceId = String(body.google_place_id || "").trim() || null;
    const now = nowIso();
    const id = randomId("cmp");

    try {
      await env.DB
        .prepare(
          `INSERT INTO companies (
             id, org_id, canonical_name, norm_name, country_en, city, website, website_domain,
             google_place_id, buyer_type, product_summary, pool_stage, primary_owner_id,
             source_contributor_id, created_by, updated_by, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          id,
          ctx.orgId,
          canonicalName,
          normName,
          countryEn,
          String(body.city || "").trim(),
          website,
          websiteDomain,
          googlePlaceId,
          String(body.buyer_type || "").trim(),
          String(body.product_summary || "").trim(),
          String(body.primary_owner_id || auth.actor.id).trim(),
          String(body.source_contributor_id || auth.actor.id).trim(),
          auth.actor.id,
          auth.actor.id,
          now,
          now
        )
        .run();
    } catch (err) {
      const msg = String((err && err.message) || "");
      if (msg.includes("UNIQUE")) {
        return json({ ok: false, code: "COMPANY_DUPLICATE_IN_ORG", error: "当前组织空间内已存在相同 google_place_id 的企业记录" }, 409, cors);
      }
      throw err;
    }

    return json({ ok: true, company: { id, org_id: ctx.orgId, canonical_name: canonicalName, country_en: countryEn, website_domain: websiteDomain, google_place_id: googlePlaceId } }, 201, cors);
  }

  const compOptOutMatch = path.match(/^\/api\/v3\/companies\/([^/]+)\/opt-out$/);
  if (compOptOutMatch && method === "POST") {
    const companyId = decodeURIComponent(compOptOutMatch[1]);
    const body = await parseJsonBody(request, 8192);
    const reqLevel = body.level === "marketing_blocked" ? "marketing_blocked" : "all_blocked";
    const row = await env.DB
      .prepare("SELECT id, opt_out_status FROM companies WHERE id = ? AND org_id = ?")
      .bind(companyId, ctx.orgId)
      .first();
    if (!row) {
      return json({ ok: false, code: "COMPANY_NOT_FOUND", error: "企业记录不存在" }, 404, cors);
    }
    const nextLevel = monotonicOptOut(row.opt_out_status, reqLevel);
    const now = nowIso();
    await env.DB
      .prepare(
        `UPDATE companies
         SET opt_out_status = ?, opt_out_meta_json = ?, derived_contact_status = 'stopped', updated_by = ?, updated_at = ?
         WHERE id = ? AND org_id = ?`
      )
      .bind(
        nextLevel,
        JSON.stringify({ reason: String(body.reason || "opt_out_recorded"), actorId: auth.actor.id, recordedAt: now }),
        auth.actor.id,
        now,
        companyId,
        ctx.orgId
      )
      .run();
    await writeAuditLog(env.DB, auth.actor, "V3_COMPANY_OPT_OUT", "company", companyId, `org=${ctx.orgId} level=${nextLevel}`);
    return json({ ok: true, company_id: companyId, opt_out_status: nextLevel, derived_contact_status: "stopped" }, 200, cors);
  }

  // =========================================================================
  // 4. Applications Review & Separated Activation (REV09)
  // =========================================================================
  if (path === "/api/v3/applications" && method === "GET") {
    if (ctx.orgType !== "company_main" || !isManagerRole(ctx)) {
      return json({ ok: false, code: "FORBIDDEN_APPLICATIONS", error: "仅公司主空间主管/总负责人可查看入驻申请列表" }, 403, cors);
    }
    const statusFilter = String(url.searchParams.get("status") || "").trim();
    const typeFilter = String(url.searchParams.get("app_type") || "").trim();
    let sql = `SELECT id, application_no, app_type, partner_mode, applicant_name, country_tz, languages,
                      contact_channel, contact_value, product_lines_json, summary_json,
                      privacy_consent_at, marketing_opt_in, status, reviewer_id, review_note,
                      quiz_passed_at, quiz_score, linked_employee_id, linked_membership_id, created_at, updated_at
               FROM applications WHERE 1=1`;
    const binds = [];
    if (statusFilter) {
      sql += " AND status = ?";
      binds.push(statusFilter);
    }
    if (typeFilter) {
      sql += " AND app_type = ?";
      binds.push(typeFilter);
    }
    sql += " ORDER BY created_at DESC LIMIT 200";
    const res = await env.DB.prepare(sql).bind(...binds).all();
    return json(
      {
        ok: true,
        applications: (res.results || []).map((r) => ({
          ...r,
          product_lines: safeJsonParse(r.product_lines_json, []),
          summary: safeJsonParse(r.summary_json, {}),
        })),
      },
      200,
      cors
    );
  }

  const appPatchMatch = path.match(/^\/api\/v3\/applications\/([^/]+)$/);
  if (appPatchMatch && method === "PATCH") {
    if (ctx.orgType !== "company_main" || !isManagerRole(ctx)) {
      return json({ ok: false, code: "FORBIDDEN_APPLICATIONS", error: "仅主管/总负责人可审核入驻申请" }, 403, cors);
    }
    const appId = decodeURIComponent(appPatchMatch[1]);
    const existing = await env.DB.prepare("SELECT * FROM applications WHERE id = ?").bind(appId).first();
    if (!existing) return json({ ok: false, code: "APPLICATION_NOT_FOUND", error: "申请记录不存在" }, 404, cors);
    const body = await parseJsonBody(request, 16384);
    const allowedNext = new Set(["pending_review", "interviewing", "need_more_info", "approved", "rejected", "training", "closed"]);
    const nextStatus = String(body.status || existing.status).trim();
    if (!allowedNext.has(nextStatus)) {
      return json({ ok: false, code: "INVALID_STATUS", error: "非法的审核状态（正式激活请调用 /activate 接口）" }, 400, cors);
    }
    const now = nowIso();
    const quizScore = body.quiz_score !== undefined ? Number(body.quiz_score) || 0 : Number(existing.quiz_score || 0);
    const quizPassedAt = body.quiz_passed === true ? now : existing.quiz_passed_at || null;
    await env.DB
      .prepare(
        `UPDATE applications
         SET status = ?, reviewer_id = ?, review_note = ?, quiz_score = ?, quiz_passed_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(nextStatus, auth.actor.id, String(body.review_note ?? existing.review_note ?? "").slice(0, 500), quizScore, quizPassedAt, now, appId)
      .run();
    await writeAuditLog(env.DB, auth.actor, "V3_APPLICATION_REVIEWED", "application", appId, `${existing.status} -> ${nextStatus}`);
    return json({ ok: true, id: appId, status: nextStatus, quiz_score: quizScore, quiz_passed_at: quizPassedAt }, 200, cors);
  }

  const appActivateMatch = path.match(/^\/api\/v3\/applications\/([^/]+)\/activate$/);
  if (appActivateMatch && method === "POST") {
    if (ctx.orgType !== "company_main" || !isManagerRole(ctx)) {
      return json({ ok: false, code: "FORBIDDEN_APPLICATIONS", error: "仅主管/总负责人可执行入驻激活" }, 403, cors);
    }
    const appId = decodeURIComponent(appActivateMatch[1]);
    const app = await env.DB.prepare("SELECT * FROM applications WHERE id = ?").bind(appId).first();
    if (!app) return json({ ok: false, code: "APPLICATION_NOT_FOUND", error: "申请记录不存在" }, 404, cors);
    if (!["approved", "training"].includes(app.status)) {
      return json(
        { ok: false, code: "ACTIVATION_REQUIRES_APPROVAL", error: "申请与激活严格分离：须先审核至 approved 或 training 状态方可正式激活" },
        409,
        cors
      );
    }
    const body = await parseJsonBody(request, 16384);
    const loginId = String(body.login_id || "").trim().toLowerCase();
    const initialPassword = String(body.initial_password || `Fg${randomHex(4)}9!`).trim();
    if (!loginId || !/^[a-z0-9._-]{3,40}$/.test(loginId)) {
      return json({ ok: false, code: "INVALID_LOGIN_ID", error: "请指定合法的登录账号 login_id（3–40位字母/数字/._-）" }, 400, cors);
    }

    const now = nowIso();
    let empId = app.linked_employee_id;
    let targetOrgId = "org_friesgo_main";
    let memRole = "staff";

    if (app.app_type === "partner") {
      memRole = app.partner_mode === "referrer" ? "partner_referrer" : "partner_followup";
    } else if (app.app_type === "tool_trial") {
      targetOrgId = randomId("org_trial");
      memRole = "independent_user";
    }

    if (!empId) {
      const existsEmp = await env.DB.prepare("SELECT id FROM employees WHERE login_id = ?").bind(loginId).first();
      if (existsEmp) {
        return json({ ok: false, code: "LOGIN_ID_EXISTS", error: "该 login_id 已存在，请更换登录名" }, 409, cors);
      }
      empId = randomId("emp");
      const pwdHash = await hashPassword(initialPassword, env.AUTH_PEPPER);
      await env.DB
        .prepare(
          `INSERT INTO employees (id, login_id, display_name, role, status, pwd_hash, pwd_salt, pwd_iter, must_reset_pwd, gmaps_monthly_cap, created_at, updated_at)
           VALUES (?, ?, ?, 'staff', 'active', ?, ?, ?, 1, 0, ?, ?)`
        )
        .bind(empId, loginId, app.applicant_name, pwdHash.hashHex, pwdHash.saltHex, pwdHash.iterations, now, now)
        .run();
    }

    if (app.app_type === "tool_trial") {
      await env.DB
        .prepare(
          `INSERT INTO orgs (id, org_type, name, status, settings_json, created_at, updated_at)
           VALUES (?, 'independent_trial', ?, 'active', ?, ?, ?)`
        )
        .bind(
          targetOrgId,
          `${app.applicant_name} Independent Workspace`,
          JSON.stringify({ trialOriginApplicationNo: app.application_no }),
          now,
          now
        )
        .run();
    }

    const membershipId = randomId("mem");
    const partnerRefCode =
      app.app_type === "partner"
        ? String(body.partner_ref_code || `PTN-${randomHex(3).toUpperCase()}`).trim()
        : null;
    const partnerApprovedTitle =
      app.app_type === "partner"
        ? String(body.partner_approved_title || "Authorized Partner Contact").trim().slice(0, 120)
        : "";

    await env.DB
      .prepare(
        `INSERT INTO org_memberships (
           id, employee_id, org_id, role, partner_ref_code, partner_approved_title,
           status, approved_by, activated_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`
      )
      .bind(membershipId, empId, targetOrgId, memRole, partnerRefCode, partnerApprovedTitle, auth.actor.id, now, now, now)
      .run();

    await env.DB
      .prepare(
        `UPDATE applications
         SET status = 'active', linked_employee_id = ?, linked_membership_id = ?, reviewer_id = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(empId, membershipId, auth.actor.id, now, appId)
      .run();

    await writeAuditLog(env.DB, auth.actor, "V3_APPLICATION_ACTIVATED", "application", appId, `emp=${empId} org=${targetOrgId} role=${memRole}`);

    return json(
      {
        ok: true,
        application_id: appId,
        employee_id: empId,
        login_id: loginId,
        initial_password_once: body.initial_password ? undefined : initialPassword,
        org_id: targetOrgId,
        membership_id: membershipId,
        role: memRole,
        partner_ref_code: partnerRefCode,
      },
      200,
      cors
    );
  }

  // =========================================================================
  // 5. Approved Product Catalog & Verified Certifications (NEW01)
  // =========================================================================
  if (path === "/api/v3/catalog" && method === "GET") {
    const res = await env.DB
      .prepare("SELECT * FROM product_catalog_approvals WHERE org_id = ? ORDER BY category_key ASC")
      .bind(ctx.orgId)
      .all();
    return json(
      {
        ok: true,
        categories: (res.results || []).map((r) => ({
          ...r,
          approved_specs: safeJsonParse(r.approved_specs_json, {}),
          verified_certs: safeJsonParse(r.verified_certs_json, []),
        })),
      },
      200,
      cors
    );
  }

  const catalogPutMatch = path.match(/^\/api\/v3\/catalog\/([^/]+)$/);
  if (catalogPutMatch && method === "PUT") {
    if (!isManagerRole(ctx) && ctx.role !== "independent_user") {
      return json({ ok: false, code: "FORBIDDEN_CATALOG", error: "仅主管/总负责人或独立空间所有者可维护核验产品目录" }, 403, cors);
    }
    const categoryKey = decodeURIComponent(catalogPutMatch[1]).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!categoryKey) return json({ ok: false, code: "INVALID_CATEGORY_KEY", error: "非法的品类键" }, 400, cors);
    const body = await parseJsonBody(request, 32768);
    const titleEn = String(body.title_en || categoryKey).trim();
    const titleCn = String(body.title_cn || titleEn).trim();
    const supplyStatus = VALID_READINESS.has(body.supply_status) ? body.supply_status : "needs_confirmation";
    const approvedSpecs = body.approved_specs && typeof body.approved_specs === "object" ? body.approved_specs : {};
    const verifiedCerts = Array.isArray(body.verified_certs) ? body.verified_certs : [];
    const moqNote = String(body.moq_note || "").trim().slice(0, 300);
    const techOwner = String(body.tech_owner_name || auth.actor.display_name).trim().slice(0, 100);
    const reviewDueAt = body.review_due_at ? String(body.review_due_at) : addDaysIso(90);
    const now = nowIso();

    const existing = await env.DB
      .prepare("SELECT id, catalog_version FROM product_catalog_approvals WHERE org_id = ? AND category_key = ?")
      .bind(ctx.orgId, categoryKey)
      .first();

    const nextVer = existing ? Number(existing.catalog_version || 1) + 1 : 1;
    const recId = existing ? existing.id : randomId("cat");

    await env.DB
      .prepare(
        `INSERT INTO product_catalog_approvals (
           id, org_id, category_key, title_en, title_cn, supply_status, approved_specs_json,
           verified_certs_json, moq_note, tech_owner_name, catalog_version, approved_by, approved_at, review_due_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(org_id, category_key) DO UPDATE SET
           title_en = excluded.title_en,
           title_cn = excluded.title_cn,
           supply_status = excluded.supply_status,
           approved_specs_json = excluded.approved_specs_json,
           verified_certs_json = excluded.verified_certs_json,
           moq_note = excluded.moq_note,
           tech_owner_name = excluded.tech_owner_name,
           catalog_version = excluded.catalog_version,
           approved_by = excluded.approved_by,
           approved_at = excluded.approved_at,
           review_due_at = excluded.review_due_at,
           updated_at = excluded.updated_at`
      )
      .bind(
        recId,
        ctx.orgId,
        categoryKey,
        titleEn,
        titleCn,
        supplyStatus,
        JSON.stringify(approvedSpecs),
        JSON.stringify(verifiedCerts),
        moqNote,
        techOwner,
        nextVer,
        auth.actor.id,
        body.approve === false ? null : now,
        reviewDueAt,
        now
      )
      .run();

    await writeAuditLog(env.DB, auth.actor, "V3_CATALOG_UPSERT", "product_catalog", recId, `org=${ctx.orgId} key=${categoryKey} v=${nextVer}`);
    return json({ ok: true, id: recId, category_key: categoryKey, catalog_version: nextVer, supply_status: supplyStatus }, 200, cors);
  }

  // =========================================================================
  // 6. Social Demand Discovery Tasks (ACQ01-03: FB/IG/LI first round, YouTube future)
  // =========================================================================
  if (path === "/api/v3/acq/tasks" && method === "GET") {
    const res = await env.DB
      .prepare("SELECT * FROM discovery_tasks WHERE org_id = ? ORDER BY updated_at DESC LIMIT 100")
      .bind(ctx.orgId)
      .all();
    return json({ ok: true, tasks: res.results || [] }, 200, cors);
  }

  if (path === "/api/v3/acq/tasks" && method === "POST") {
    if (isPartnerRole(ctx)) {
      return json({ ok: false, code: "FORBIDDEN_DISCOVERY_TASK", error: "发现任务由内部主管或独立空间所有者创建配置" }, 403, cors);
    }
    const body = await parseJsonBody(request, 16384);
    const platform = String(body.platform || "facebook").trim().toLowerCase();
    const acqMode = String(body.acquisition_mode || "manual_discovery").trim().toLowerCase();
    const title = String(body.title || "").trim();
    if (!VALID_TASK_PLATFORMS.has(platform)) {
      return json({ ok: false, code: "INVALID_PLATFORM", error: "平台仅支持 facebook / instagram / linkedin / youtube / website / radar / other" }, 400, cors);
    }
    if (!VALID_ACQ_MODES.has(acqMode)) {
      return json({ ok: false, code: "INVALID_ACQ_MODE", error: "非法的获客方式枚举" }, 400, cors);
    }
    if (!title) return json({ ok: false, code: "TITLE_REQUIRED", error: "请填写发现任务名称" }, 400, cors);

    let hoursTenths = 0;
    if (body.hours_logged_tenths !== undefined && body.hours_logged_tenths !== null && body.hours_logged_tenths !== "") {
      try {
        hoursTenths = Number(parseExactSafeIntBigInt(body.hours_logged_tenths, "hours_logged_tenths", { allowNegative: false }));
      } catch {
        return json({ ok: false, code: "INVALID_HOURS", error: "工时 hours_logged_tenths 须为非负整数（0.1 小时为单位）" }, 400, cors);
      }
    }
    const spendParsed = parseTaskSpendStrict(body.actual_spend_minor, body.spend_currency, "");
    if (!spendParsed.ok) {
      return json({ ok: false, code: spendParsed.code, error: spendParsed.error }, 400, cors);
    }

    const now = nowIso();
    const id = randomId("tsk");

    await env.DB
      .prepare(
        `INSERT INTO discovery_tasks (
           id, org_id, platform, acquisition_mode, title, target_buyer_roles, product_keywords,
           intent_keywords, exclude_keywords, language, country_scope, owner_employee_id,
           review_window_days, candidate_cap, hours_logged_tenths, actual_spend_minor, spend_currency,
           status, created_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
      )
      .bind(
        id,
        ctx.orgId,
        platform,
        acqMode,
        title.slice(0, 160),
        String(body.target_buyer_roles || "").slice(0, 200),
        String(body.product_keywords || "").slice(0, 300),
        String(body.intent_keywords || "").slice(0, 300),
        String(body.exclude_keywords || "").slice(0, 300),
        String(body.language || "").slice(0, 40),
        String(body.country_scope || "ANY").slice(0, 80),
        String(body.owner_employee_id || auth.actor.id).trim(),
        Math.max(1, Math.min(90, Number(body.review_window_days || 14) || 14)),
        Math.max(1, Math.min(1000, Number(body.candidate_cap || 50) || 50)),
        hoursTenths,
        spendParsed.minor,
        spendParsed.currency,
        auth.actor.id,
        now,
        now
      )
      .run();

    return json(
      {
        ok: true,
        task: {
          id,
          org_id: ctx.orgId,
          platform,
          acquisition_mode: acqMode,
          title,
          country_scope: String(body.country_scope || "ANY"),
          hours_logged_tenths: hoursTenths,
          actual_spend_minor: spendParsed.minor,
          spend_currency: spendParsed.currency,
        },
      },
      201,
      cors
    );
  }

  const taskPatchMatch = path.match(/^\/api\/v3\/acq\/tasks\/([^/]+)$/);
  if (taskPatchMatch && method === "PATCH") {
    if (isPartnerRole(ctx)) {
      return json({ ok: false, code: "FORBIDDEN_DISCOVERY_TASK", error: "无权修改发现任务" }, 403, cors);
    }
    const taskId = decodeURIComponent(taskPatchMatch[1]);
    const existing = await env.DB.prepare("SELECT * FROM discovery_tasks WHERE id = ? AND org_id = ?").bind(taskId, ctx.orgId).first();
    if (!existing) return json({ ok: false, code: "TASK_NOT_FOUND", error: "发现任务不存在" }, 404, cors);
    const body = await parseJsonBody(request, 8192);

    let nextHours = Number(existing.hours_logged_tenths || 0);
    if (body.add_hours_tenths !== undefined && body.add_hours_tenths !== null && body.add_hours_tenths !== "") {
      try {
        nextHours += Number(parseExactSafeIntBigInt(body.add_hours_tenths, "add_hours_tenths", { allowNegative: false }));
      } catch {
        return json({ ok: false, code: "INVALID_HOURS", error: "追加工时 add_hours_tenths 须为非负整数" }, 400, cors);
      }
    } else if (body.hours_logged_tenths !== undefined && body.hours_logged_tenths !== null && body.hours_logged_tenths !== "") {
      try {
        nextHours = Number(parseExactSafeIntBigInt(body.hours_logged_tenths, "hours_logged_tenths", { allowNegative: false }));
      } catch {
        return json({ ok: false, code: "INVALID_HOURS", error: "工时 hours_logged_tenths 须为非负整数" }, 400, cors);
      }
    }

    const rawSpend = body.actual_spend_minor === undefined ? existing.actual_spend_minor : body.actual_spend_minor;
    const spendParsed = parseTaskSpendStrict(rawSpend, body.spend_currency, existing.spend_currency || "");
    if (!spendParsed.ok) {
      return json({ ok: false, code: spendParsed.code, error: spendParsed.error }, 400, cors);
    }

    const nextStatus = ["active", "paused", "completed", "archived"].includes(body.status) ? body.status : existing.status;
    await env.DB
      .prepare(
        `UPDATE discovery_tasks
         SET hours_logged_tenths = ?, actual_spend_minor = ?, spend_currency = ?, status = ?, updated_at = ?
         WHERE id = ? AND org_id = ?`
      )
      .bind(nextHours, spendParsed.minor, spendParsed.currency, nextStatus, nowIso(), taskId, ctx.orgId)
      .run();
    return json(
      {
        ok: true,
        id: taskId,
        hours_logged_tenths: nextHours,
        actual_spend_minor: spendParsed.minor,
        spend_currency: spendParsed.currency,
        status: nextStatus,
      },
      200,
      cors
    );
  }

  // =========================================================================
  // 7. Social Demand Signals: Intake, Explainable Triage, Audit, Draft vs Manual Send (ACQ04-09)
  // =========================================================================
  if (path === "/api/v3/acq/signals" && method === "GET") {
    const plat = String(url.searchParams.get("platform") || "").trim().toLowerCase();
    const auditStatus = String(url.searchParams.get("audit_status") || "").trim();
    const contactResult = String(url.searchParams.get("contact_result") || "").trim();
    let sql = "SELECT * FROM demand_signals WHERE org_id = ?";
    const binds = [ctx.orgId];
    if (isPartnerRole(ctx)) {
      sql += " AND (created_by = ? OR referrer_employee_id = ? OR id IN (SELECT signal_id FROM lead_assignments WHERE org_id = ? AND primary_assignee_id = ? AND assignment_status IN ('pending_accept','accepted') AND signal_id != ''))";
      binds.push(auth.actor.id, auth.actor.id, ctx.orgId, auth.actor.id);
    }
    if (plat) {
      sql += " AND source_platform = ?";
      binds.push(plat);
    }
    if (auditStatus) {
      sql += " AND audit_status = ?";
      binds.push(auditStatus);
    }
    if (contactResult) {
      sql += " AND contact_result = ?";
      binds.push(contactResult);
    }
    sql += " ORDER BY created_at DESC LIMIT 200";
    const res = await env.DB.prepare(sql).bind(...binds).all();
    return json(
      {
        ok: true,
        signals: (res.results || []).map((r) => ({
          ...r,
          judgment_tags: safeJsonParse(r.judgment_tags_json, {}),
          missing_info: safeJsonParse(r.missing_info_json, []),
          ai_inferred_fields: safeJsonParse(r.ai_inferred_fields_json, {}),
        })),
      },
      200,
      cors
    );
  }

  if (path === "/api/v3/acq/signals" && method === "POST") {
    const body = await parseJsonBody(request, 32768);
    const idemKey = String(request.headers.get("X-Idempotency-Key") || body.idem_key || "").trim();

    const idemRes = await runIdempotentOperation(env.DB, {
      orgId: ctx.orgId,
      actorId: auth.actor.id,
      scope: "v3_signal_create",
      targetId: "",
      idemKey,
      requestBody: body,
      executor: async ({ idemKey: activeIdemKey }) => {
        // S08 Defense-in-depth: if an out-of-band crash left a committed signal row with same (org_id, created_by, idem_key), return it cleanly!
        if (activeIdemKey) {
          const existingByIdem = await env.DB
            .prepare("SELECT * FROM demand_signals WHERE org_id = ? AND created_by = ? AND idem_key = ? LIMIT 1")
            .bind(ctx.orgId, auth.actor.id, activeIdemKey)
            .first();
          if (existingByIdem) {
            return {
              status: 201,
              body: {
                ok: true,
                signal: {
                  id: existingByIdem.id,
                  org_id: existingByIdem.org_id,
                  source_platform: existingByIdem.source_platform,
                  acquisition_mode: existingByIdem.acquisition_mode,
                  signal_tier: existingByIdem.signal_tier,
                  published_at: existingByIdem.published_at,
                  audit_status: existingByIdem.audit_status,
                  contact_result: existingByIdem.contact_result,
                  judgment_tags: safeJsonParse(existingByIdem.judgment_tags_json, {}),
                  missing_info: safeJsonParse(existingByIdem.missing_info_json, []),
                  duplicateHints: [],
                },
              },
              commitStmts: [],
            };
          }
        }

        const sourcePlatform = String(body.source_platform || "facebook").trim().toLowerCase();
        const acqMode = String(body.acquisition_mode || "manual_discovery").trim().toLowerCase();
        const signalTier = VALID_SIGNAL_TIERS.has(body.signal_tier) ? body.signal_tier : "potential_demand";
        const demandSummary = String(body.demand_summary || "").trim();
        if (!VALID_SIGNAL_PLATFORMS.has(sourcePlatform)) {
          return { status: 400, body: { ok: false, code: "INVALID_PLATFORM", error: "不支持的来源平台枚举" } };
        }
        if (!VALID_ACQ_MODES.has(acqMode)) {
          return { status: 400, body: { ok: false, code: "INVALID_ACQ_MODE", error: "不支持的获客方式枚举" } };
        }
        if (demandSummary.length < 5) {
          return { status: 400, body: { ok: false, code: "SUMMARY_REQUIRED", error: "请填写需求摘要（至少 5 个字符）" } };
        }

        const taskId = String(body.task_id || "").trim();
        if (taskId) {
          const taskRow = await env.DB.prepare("SELECT id FROM discovery_tasks WHERE id = ? AND org_id = ?").bind(taskId, ctx.orgId).first();
          if (!taskRow) {
            return { status: 404, body: { ok: false, code: "TASK_NOT_FOUND", error: "关联的发现任务不存在或不属于当前组织空间" } };
          }
        }

        const externalId = String(body.external_id || "").trim().slice(0, 120);
        const sourceUrl = String(body.source_url || "").trim().slice(0, 500);
        const publishedAt = body.published_at ? String(body.published_at).trim() : null; // ACQ04: unknown stays NULL!
        const countryEn = String(body.country_en || "").trim().slice(0, 80);
        const productLine = String(body.product_line || "").trim().slice(0, 80);
        const companyName = String(body.company_name || "").trim().slice(0, 120);
        const buyerRole = VALID_BUYER_ROLES.has(body.buyer_role) ? body.buyer_role : "unknown";
        const contactChannel = String(body.contact_channel || "").trim().slice(0, 160);
        const readiness = VALID_READINESS.has(body.fulfillment_readiness) ? body.fulfillment_readiness : "needs_confirmation";
        const linkedCompanyId = String(body.linked_company_id || "").trim();

        if (linkedCompanyId) {
          const cmp = await env.DB.prepare("SELECT id FROM companies WHERE id = ? AND org_id = ?").bind(linkedCompanyId, ctx.orgId).first();
          if (!cmp) {
            return { status: 404, body: { ok: false, code: "COMPANY_NOT_FOUND", error: "关联企业不属于当前组织空间" } };
          }
        }

        // Dedupe hint check within current org (ACQ06: preserve original touchpoint, detect same source/external_id)
        const duplicateHints = [];
        if (externalId) {
          const dupExt = await env.DB
            .prepare("SELECT id, audit_status, linked_project_id, linked_inquiry_id FROM demand_signals WHERE org_id = ? AND source_platform = ? AND external_id = ? LIMIT 3")
            .bind(ctx.orgId, sourcePlatform, externalId)
            .all();
          for (const d of dupExt.results || []) {
            duplicateHints.push({ kind: "same_source_external_id", signal_id: d.id, audit_status: d.audit_status });
          }
        }
        if (companyName) {
          const norm = normalizeCompanyName(companyName);
          if (norm) {
            const dupCmp = await env.DB
              .prepare("SELECT id, canonical_name FROM companies WHERE org_id = ? AND norm_name = ? AND deleted_at IS NULL LIMIT 3")
              .bind(ctx.orgId, norm)
              .all();
            for (const c of dupCmp.results || []) {
              // Blind dedupe for partners: never reveal existing internal company names!
              if (!isPartnerRole(ctx)) {
                duplicateHints.push({ kind: "existing_company", company_id: c.id, canonical_name: c.canonical_name });
              }
            }
          }
        }

        const { judgmentTags, missingInfo } = buildExplainableJudgment({
          demandSummary,
          countryEn,
          productLine,
          buyerRole,
          publishedAt,
          contactChannel,
          sourceUrl,
        });

        const now = nowIso();
        const id = randomId("sig");
        const insertStmt = env.DB
          .prepare(
            `INSERT INTO demand_signals (
               id, org_id, task_id, source_platform, acquisition_mode, signal_tier,
               source_url, external_id, published_at, discovered_at, language, country_en,
               product_line, fulfillment_readiness, company_name, buyer_role, contact_name,
               contact_channel, demand_summary, usage_license_scope, ai_inferred_fields_json,
               judgment_tags_json, missing_info_json, audit_status, contact_result,
               opt_out_locked, opt_out_at, idem_key,
               referrer_employee_id, linked_company_id, created_by, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_verify', 'to_contact', 0, NULL, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            id,
            ctx.orgId,
            taskId,
            sourcePlatform,
            acqMode,
            signalTier,
            sourceUrl,
            externalId,
            publishedAt,
            now,
            String(body.language || "").slice(0, 32),
            countryEn,
            productLine,
            readiness,
            companyName,
            buyerRole,
            String(body.contact_name || "").slice(0, 100),
            contactChannel,
            demandSummary,
            String(body.usage_license_scope || "manual_review_only").slice(0, 64),
            JSON.stringify(body.ai_inferred_fields && typeof body.ai_inferred_fields === "object" ? body.ai_inferred_fields : {}),
            JSON.stringify(judgmentTags),
            JSON.stringify(missingInfo),
            activeIdemKey || "",
            isPartnerRole(ctx) ? auth.actor.id : String(body.referrer_employee_id || "").trim(),
            linkedCompanyId,
            auth.actor.id,
            now,
            now
          );

        return {
          status: 201,
          body: {
            ok: true,
            signal: {
              id,
              org_id: ctx.orgId,
              source_platform: sourcePlatform,
              acquisition_mode: acqMode,
              signal_tier: signalTier,
              published_at: publishedAt,
              audit_status: "pending_verify",
              contact_result: "to_contact",
              judgment_tags: judgmentTags,
              missing_info: missingInfo,
              duplicateHints,
            },
          },
          commitStmts: [insertStmt],
        };
      },
    });
    return json({ ...idemRes.body, replayed: Boolean(idemRes.replayed) }, idemRes.status, cors);
  }

  // Signal Audit & Controlled Promotion (ACQ06: prevents duplicate dispatch of same demand)
  const sigAuditMatch = path.match(/^\/api\/v3\/acq\/signals\/([^/]+)\/audit$/);
  if (sigAuditMatch && method === "POST") {
    if (isPartnerRole(ctx)) {
      return json({ ok: false, code: "FORBIDDEN_SIGNAL_AUDIT", error: "仅内部人员或独立空间所有者可审核需求信号" }, 403, cors);
    }
    const signalId = decodeURIComponent(sigAuditMatch[1]);
    const sig = await env.DB.prepare("SELECT * FROM demand_signals WHERE id = ? AND org_id = ?").bind(signalId, ctx.orgId).first();
    if (!sig) return json({ ok: false, code: "SIGNAL_NOT_FOUND", error: "需求信号不存在" }, 404, cors);

    const body = await parseJsonBody(request, 16384);
    const nextAudit = String(body.audit_status || "verified_valid").trim();
    if (!VALID_AUDIT_STATUSES.has(nextAudit)) {
      return json({ ok: false, code: "INVALID_AUDIT_STATUS", error: "非法的审核状态" }, 400, cors);
    }
    const nextReadiness = VALID_READINESS.has(body.fulfillment_readiness) ? body.fulfillment_readiness : sig.fulfillment_readiness;
    const auditReason = String(body.audit_reason || "").trim().slice(0, 300);
    const promoteTo = String(body.promote_to || "").trim(); // '' | 'dev_lead' | 'valid_inquiry'
    const now = nowIso();

    let linkedProjectId = String(body.linked_project_id || sig.linked_project_id || "").trim();
    if (linkedProjectId) {
      const prj = await env.DB.prepare("SELECT id FROM projects WHERE id = ? AND org_id = ?").bind(linkedProjectId, ctx.orgId).first();
      if (!prj) return json({ ok: false, code: "PROJECT_NOT_FOUND", error: "关联项目不属于当前组织空间" }, 404, cors);
    }

    let linkedInquiryId = sig.linked_inquiry_id || "";
    let createdAssignmentId = "";
    let duplicateDispatchPrevented = false;

    const stmts = [
      env.DB
        .prepare(
          `UPDATE demand_signals
           SET audit_status = ?, audit_reason = ?, fulfillment_readiness = ?, last_verified_at = ?, linked_project_id = ?, updated_at = ?
           WHERE id = ? AND org_id = ?`
        )
        .bind(nextAudit, auditReason, nextReadiness, now, linkedProjectId, now, signalId, ctx.orgId),
    ];

    if ((nextAudit === "verified_valid" || nextAudit === "approved") && (promoteTo === "dev_lead" || promoteTo === "valid_inquiry")) {
      // ACQ06: Check if same demand signal OR same (platform, external_id) already has an active dispatch!
      let dupAsg = await env.DB
        .prepare(
          `SELECT id FROM lead_assignments
           WHERE org_id = ? AND signal_id = ? AND assignment_status NOT IN ('rejected','reclaimed')
           LIMIT 1`
        )
        .bind(ctx.orgId, signalId)
        .first();
      if (!dupAsg && sig.external_id) {
        dupAsg = await env.DB
          .prepare(
            `SELECT a.id FROM lead_assignments a
             JOIN demand_signals s ON s.id = a.signal_id
             WHERE a.org_id = ? AND s.org_id = ? AND s.source_platform = ? AND s.external_id = ?
               AND a.assignment_status NOT IN ('rejected','reclaimed')
             LIMIT 1`
          )
          .bind(ctx.orgId, ctx.orgId, sig.source_platform, sig.external_id)
          .first();
      }

      if (dupAsg) {
        duplicateDispatchPrevented = true;
      } else {
        if (promoteTo === "valid_inquiry" && !linkedInquiryId) {
          linkedInquiryId = randomId("inq");
          const ymd = now.slice(0, 10).replace(/-/g, "");
          const inqNo = `FG-INQ-${ymd}-${randomHex(3).toUpperCase()}`;
          stmts.push(
            env.DB
              .prepare(
                `INSERT INTO inquiries (
                   id, org_id, inquiry_no, company_id, project_id, source_signal_id,
                   source_platform, acquisition_mode, country_en, product_line, summary,
                   contact_channel, referrer_employee_id, status, created_by, created_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`
              )
              .bind(
                linkedInquiryId,
                ctx.orgId,
                inqNo,
                sig.linked_company_id || "",
                linkedProjectId,
                signalId,
                sig.source_platform,
                sig.acquisition_mode,
                sig.country_en,
                sig.product_line,
                sig.demand_summary,
                sig.contact_channel,
                sig.referrer_employee_id || "",
                auth.actor.id,
                now,
                now
              )
          );
          stmts.push(
            env.DB
              .prepare("UPDATE demand_signals SET linked_inquiry_id = ?, contact_result = 'converted_inquiry', updated_at = ? WHERE id = ? AND org_id = ?")
              .bind(linkedInquiryId, now, signalId, ctx.orgId)
          );
        }

        createdAssignmentId = randomId("asg");
        const opId = randomId("op");
        stmts.push(
          env.DB
            .prepare(
              `INSERT INTO lead_assignments (
                 id, org_id, company_id, project_id, inquiry_id, signal_id, lead_kind,
                 assignment_status, business_stage, source_contributor_id, assigned_by,
                 last_op_id, version, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_dispatch', ?, ?, ?, ?, 1, ?, ?)`
            )
            .bind(
              createdAssignmentId,
              ctx.orgId,
              sig.linked_company_id || "",
              linkedProjectId,
              linkedInquiryId,
              signalId,
              promoteTo,
              promoteTo === "valid_inquiry" ? "inquired" : "to_contact",
              sig.referrer_employee_id || sig.created_by || "",
              auth.actor.id,
              opId,
              now,
              now
            )
        );
        stmts.push(
          env.DB
            .prepare(
              `INSERT INTO assignment_events (id, org_id, assignment_id, op_id, event_type, actor_id, reason, meta_json, created_at)
               VALUES (?, ?, ?, ?, 'created', ?, 'signal_audit_promoted', ?, ?)`
            )
            .bind(randomId("aev"), ctx.orgId, createdAssignmentId, opId, auth.actor.id, JSON.stringify({ signalId, promoteTo }), now)
        );
      }
    }

    await executeAtomicBatch(env.DB, stmts);
    await writeAuditLog(env.DB, auth.actor, "V3_SIGNAL_AUDITED", "demand_signal", signalId, `status=${nextAudit} promote=${promoteTo} dupPrevented=${duplicateDispatchPrevented}`);
    return json(
      {
        ok: true,
        signal_id: signalId,
        audit_status: nextAudit,
        fulfillment_readiness: nextReadiness,
        linked_inquiry_id: linkedInquiryId || null,
        created_assignment_id: createdAssignmentId || null,
        duplicateDispatchPrevented,
      },
      200,
      cors
    );
  }

  // ACQ07 / S03 / S05: Generate editable reply draft ONLY from approved catalog facts; NEVER counts as outreach!
  const sigDraftMatch = path.match(/^\/api\/v3\/acq\/signals\/([^/]+)\/draft$/);
  if (sigDraftMatch && method === "POST") {
    const signalId = decodeURIComponent(sigDraftMatch[1]);
    const sig = await env.DB.prepare("SELECT * FROM demand_signals WHERE id = ? AND org_id = ?").bind(signalId, ctx.orgId).first();
    if (!sig || !(await canActorAccessSignal(env.DB, ctx, auth.actor.id, sig))) {
      return json({ ok: false, code: "SIGNAL_NOT_FOUND", error: "需求信号不存在或无权访问" }, 404, cors);
    }

    const optState = await checkSignalOptOutState(env.DB, ctx, sig);
    const optOutBlocked = optState.blocked;
    const companyOptOutStatus = optState.companyOptOutStatus;

    const activeAssign = await env.DB
      .prepare("SELECT primary_assignee_id, assignment_status FROM lead_assignments WHERE org_id = ? AND signal_id = ? AND assignment_status IN ('pending_accept','accepted') LIMIT 1")
      .bind(ctx.orgId, signalId)
      .first();

    // Fetch ONLY approved, non-expired catalog facts for this product line (NEW01 + ACQ07)
    const now = nowIso();
    let approvedCat = null;
    if (sig.product_line) {
      approvedCat = await env.DB
        .prepare(
          `SELECT title_en, title_cn, supply_status, approved_specs_json, verified_certs_json, moq_note
           FROM product_catalog_approvals
           WHERE org_id = ? AND category_key = ? AND approved_at IS NOT NULL AND (review_due_at IS NULL OR review_due_at > ?)
           LIMIT 1`
        )
        .bind(ctx.orgId, sig.product_line.toLowerCase(), now)
        .first();
    }

    const body = await parseJsonBody(request, 8192);
    const lang = String(body.lang || sig.language || "en").toLowerCase();
    const missing = safeJsonParse(sig.missing_info_json, []);
    const certs = approvedCat ? safeJsonParse(approvedCat.verified_certs_json, []) : [];
    const certLine = certs.length ? `Verified certifications on file: ${certs.join(", ")}.` : "Detailed specs & certifications can be confirmed by our export engineering desk.";
    const rfqGuideUrl = `rfq.html?src=${encodeURIComponent(sig.source_platform)}&sig=${encodeURIComponent(sig.id)}${ctx.membership && ctx.membership.partner_ref_code ? `&ref=${encodeURIComponent(ctx.membership.partner_ref_code)}` : ""}`;

    const draftText = optOutBlocked
      ? "[禁止联系 / DO NOT CONTACT] 该客户/信号已标记退订或阻断状态，请立即停止一切主动开发动作。"
      : lang.startsWith("zh")
      ? `您好，关注到贵方关于「${approvedCat ? approvedCat.title_cn : sig.product_line || "工业产品"}」的采购讨论。我们是 FriesGo Global 官方出口团队，可协助核对技术规格并提供正式报价。为方便准确报价，如方便可告知预估数量、项目所在国及交付港（部分规格未确定可由工程师协助确认）。您也可以通过此询价页补充信息：${rfqGuideUrl}`
      : `Hello, we noticed your discussion regarding ${approvedCat ? approvedCat.title_en : sig.product_line || "industrial supply"}. ${certLine} To prepare an accurate official quotation from FriesGo Global, could you share your target specifications, estimated quantity, and destination country/port (if any specs are still open, our engineers can help confirm)? You may also share details directly via our inquiry form: ${rfqGuideUrl}`;

    // Increment ONLY draft_count — NEVER manual_sent_count or contact_result!
    await env.DB
      .prepare("UPDATE demand_signals SET draft_count = draft_count + 1, updated_at = ? WHERE id = ? AND org_id = ?")
      .bind(now, signalId, ctx.orgId)
      .run();

    return json(
      {
        ok: true,
        signal_id: signalId,
        optOutBlocked,
        companyOptOutStatus,
        alreadyFollowedBy: activeAssign ? activeAssign.primary_assignee_id : null,
        approvedCatalogUsed: Boolean(approvedCat),
        missingInfoChecklist: missing,
        draftText,
        rfqGuideUrl,
        notice: "草稿生成仅记录辅助次数，不计入人工触达；请由人工审核后在原平台或经允许渠道亲自发送，再登记「已人工发送」。",
      },
      200,
      cors
    );
  }

  // ACQ07 / ACQ09 / S03 / S05: Strict separation of copied vs manual_sent vs replied vs opted_out vs convert_inquiry
  const sigActionMatch = path.match(/^\/api\/v3\/acq\/signals\/([^/]+)\/contact-action$/);
  if (sigActionMatch && method === "POST") {
    const signalId = decodeURIComponent(sigActionMatch[1]);
    const sig = await env.DB.prepare("SELECT * FROM demand_signals WHERE id = ? AND org_id = ?").bind(signalId, ctx.orgId).first();
    if (!sig || !(await canActorAccessSignal(env.DB, ctx, auth.actor.id, sig))) {
      return json({ ok: false, code: "SIGNAL_NOT_FOUND", error: "需求信号不存在或无权访问" }, 404, cors);
    }

    const body = await parseJsonBody(request, 16384);
    const action = String(body.action || "").trim();
    const now = nowIso();

    if (action === "opted_out") {
      const stmts = [
        env.DB
          .prepare(
            `UPDATE demand_signals
             SET contact_result = 'opted_out',
                 opt_out_locked = 1,
                 opt_out_at = COALESCE(opt_out_at, ?),
                 next_action = '已拒绝联系，停止开发',
                 updated_at = ?
             WHERE id = ? AND org_id = ?`
          )
          .bind(now, now, signalId, ctx.orgId),
      ];
      if (sig.linked_company_id) {
        stmts.push(
          env.DB
            .prepare("UPDATE companies SET opt_out_status = 'all_blocked', derived_contact_status = 'stopped', updated_at = ? WHERE id = ? AND org_id = ?")
            .bind(now, sig.linked_company_id, ctx.orgId)
        );
      }
      await executeAtomicBatch(env.DB, stmts);
      await writeAuditLog(env.DB, auth.actor, "V3_SIGNAL_OPT_OUT", "demand_signal", signalId, `org=${ctx.orgId} locked=1`);
      return json({ ok: true, action: "opted_out", signal_id: signalId, contact_result: "opted_out", opt_out_locked: 1 }, 200, cors);
    }

    // S05: Hard monotonic opt-out lock — NEVER allow ANY ordinary action (replied, manual_sent, need_specs, waiting_reply, paused, invalid, convert_inquiry, copied) to overwrite or bypass opt_out_locked!
    const optState = await checkSignalOptOutState(env.DB, ctx, sig);
    if (optState.blocked) {
      return json(
        {
          ok: false,
          code: "OPT_OUT_BLOCKED",
          error: "该信号或关联企业已处于退订/合规阻断锁定状态，禁止任何普通状态覆盖或继续触达（仅可由主管提供再授权凭证走审计解锁流程）",
        },
        409,
        cors
      );
    }

    if (action === "copied" || action === "opened_source") {
      await env.DB
        .prepare("UPDATE demand_signals SET copy_count = copy_count + 1, updated_at = ? WHERE id = ? AND org_id = ?")
        .bind(now, signalId, ctx.orgId)
        .run();
      return json(
        {
          ok: true,
          action,
          signal_id: signalId,
          copy_count: Number(sig.copy_count || 0) + 1,
          manual_sent_count: Number(sig.manual_sent_count || 0),
          contact_result: sig.contact_result,
          countedAsOutreach: false,
        },
        200,
        cors
      );
    }

    if (action === "manual_sent") {
      await env.DB
        .prepare(
          `UPDATE demand_signals
           SET manual_sent_count = manual_sent_count + 1,
               manual_sent_at = COALESCE(manual_sent_at, ?),
               contact_result = 'manual_sent',
               next_action = ?,
               next_action_due_at = ?,
               updated_at = ?
           WHERE id = ? AND org_id = ?`
        )
        .bind(
          now,
          String(body.next_action || "等待买方回复并跟进规格确认").slice(0, 200),
          body.next_action_due_at || addDaysIso(2),
          now,
          signalId,
          ctx.orgId
        )
        .run();
      return json(
        {
          ok: true,
          action: "manual_sent",
          signal_id: signalId,
          manual_sent_count: Number(sig.manual_sent_count || 0) + 1,
          contact_result: "manual_sent",
          countedAsOutreach: true,
        },
        200,
        cors
      );
    }

    if (action === "replied") {
      await env.DB
        .prepare(
          `UPDATE demand_signals
           SET contact_result = 'active_dialogue',
               replied_at = COALESCE(replied_at, ?),
               next_action = ?,
               next_action_due_at = ?,
               updated_at = ?
           WHERE id = ? AND org_id = ?`
        )
        .bind(
          now,
          String(body.next_action || "引导买方确认详细规格或提交正式询价").slice(0, 200),
          body.next_action_due_at || addDaysIso(1),
          now,
          signalId,
          ctx.orgId
        )
        .run();
      return json({ ok: true, action: "replied", signal_id: signalId, contact_result: "active_dialogue" }, 200, cors);
    }

    if (["need_specs", "waiting_reply", "paused", "invalid"].includes(action)) {
      await env.DB
        .prepare("UPDATE demand_signals SET contact_result = ?, next_action = ?, next_action_due_at = ?, updated_at = ? WHERE id = ? AND org_id = ?")
        .bind(action, String(body.next_action || "").slice(0, 200), body.next_action_due_at || sig.next_action_due_at, now, signalId, ctx.orgId)
        .run();
      return json({ ok: true, action, signal_id: signalId, contact_result: action }, 200, cors);
    }

    if (action === "convert_inquiry") {
      if (sig.linked_inquiry_id) {
        return json({ ok: true, signal_id: signalId, inquiry_id: sig.linked_inquiry_id, alreadyConverted: true }, 200, cors);
      }
      const inqId = randomId("inq");
      const ymd = now.slice(0, 10).replace(/-/g, "");
      const inqNo = `FG-INQ-${ymd}-${randomHex(3).toUpperCase()}`;
      await executeAtomicBatch(env.DB, [
        env.DB
          .prepare(
            `INSERT INTO inquiries (
               id, org_id, inquiry_no, company_id, project_id, source_signal_id,
               source_platform, acquisition_mode, country_en, product_line, summary,
               specs_json, contact_channel, referrer_employee_id, primary_owner_id,
               status, created_by, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`
          )
          .bind(
            inqId,
            ctx.orgId,
            inqNo,
            sig.linked_company_id || "",
            sig.linked_project_id || "",
            signalId,
            sig.source_platform,
            sig.acquisition_mode,
            sig.country_en,
            sig.product_line,
            String(body.summary || sig.demand_summary),
            JSON.stringify(body.specs || {}),
            sig.contact_channel,
            sig.referrer_employee_id || "",
            auth.actor.id,
            auth.actor.id,
            now,
            now
          ),
        env.DB
          .prepare("UPDATE demand_signals SET linked_inquiry_id = ?, contact_result = 'converted_inquiry', updated_at = ? WHERE id = ? AND org_id = ?")
          .bind(inqId, now, signalId, ctx.orgId),
      ]);
      return json({ ok: true, action: "convert_inquiry", signal_id: signalId, inquiry_id: inqId, inquiry_no: inqNo }, 201, cors);
    }

    return json({ ok: false, code: "INVALID_CONTACT_ACTION", error: "不支持的联系动作类型" }, 400, cors);
  }

  // S05: Audited Manager/Owner Re-Consent Unlock (ONLY authorized path to lift opt_out_locked)
  const sigReconsentMatch = path.match(/^\/api\/v3\/acq\/signals\/([^/]+)\/reconsent$/);
  if (sigReconsentMatch && method === "POST") {
    if (!isManagerRole(ctx) && ctx.role !== "independent_user") {
      return json({ ok: false, code: "FORBIDDEN_RECONSENT", error: "仅主管/总负责人或独立空间所有者可登记客户再授权解锁" }, 403, cors);
    }
    const signalId = decodeURIComponent(sigReconsentMatch[1]);
    const sig = await env.DB.prepare("SELECT * FROM demand_signals WHERE id = ? AND org_id = ?").bind(signalId, ctx.orgId).first();
    if (!sig) return json({ ok: false, code: "SIGNAL_NOT_FOUND", error: "需求信号不存在" }, 404, cors);

    const body = await parseJsonBody(request, 8192);
    const reason = String(body.reason || "").trim();
    const evidence = String(body.consent_evidence || "").trim();
    if (reason.length < 5 || evidence.length < 5) {
      return json({ ok: false, code: "RECONSENT_EVIDENCE_REQUIRED", error: "解除退订锁定须同时提供解锁原因（reason）与客户重新授权凭证（consent_evidence，至少 5 字符）" }, 400, cors);
    }

    if (sig.linked_company_id) {
      const cmp = await env.DB
        .prepare("SELECT opt_out_status, compliance_status FROM companies WHERE id = ? AND org_id = ?")
        .bind(sig.linked_company_id, ctx.orgId)
        .first();
      if (cmp && (cmp.opt_out_status !== "none" || cmp.compliance_status === "blocked")) {
        return json({ ok: false, code: "COMPANY_OPT_OUT_ACTIVE", error: "关联企业主档仍处于退订/合规阻断状态，无法单独解锁该信号" }, 409, cors);
      }
    }

    const now = nowIso();
    await env.DB
      .prepare(
        `UPDATE demand_signals
         SET opt_out_locked = 0, contact_result = 'to_contact', next_action = '客户已重新授权，待人工复核跟进', updated_at = ?
         WHERE id = ? AND org_id = ?`
      )
      .bind(now, signalId, ctx.orgId)
      .run();
    await writeAuditLog(
      env.DB,
      auth.actor,
      "V3_SIGNAL_RECONSENT",
      "demand_signal",
      signalId,
      `org=${ctx.orgId} reason=${reason.slice(0, 120)} evidence=${evidence.slice(0, 160)}`
    );
    return json({ ok: true, signal_id: signalId, opt_out_locked: 0, contact_result: "to_contact" }, 200, cors);
  }

  // =========================================================================
  // 8. ACQ10 / N02 / N03 / N04 Source Comparison with Honest Denominators,
  //    Per-Currency Spend Breakdown, Matching Task Scope/Window & Zero-Yield Tasks
  // =========================================================================
  if (path === "/api/v3/acq/source-comparison" && method === "GET") {
    if (isPartnerRole(ctx)) {
      return json({ ok: false, code: "FORBIDDEN_SOURCE_COMPARISON", error: "来源对比统计仅对授权主管/内部成员或独立空间所有者开放" }, 403, cors);
    }
    const fromDate = String(url.searchParams.get("from") || "").trim();
    const toDate = String(url.searchParams.get("to") || "").trim();
    const tzOffsetParam = url.searchParams.get("tz_offset_minutes");
    const countryFilter = String(url.searchParams.get("country") || "").trim().toLowerCase();
    const productFilter = String(url.searchParams.get("product_line") || "").trim().toLowerCase();

    const win = parseDateWindow(fromDate, toDate, tzOffsetParam);
    if (!win.ok) {
      return json({ ok: false, code: win.code || "INVALID_DATE_RANGE", error: win.error }, 400, cors);
    }

    const sigRes = await env.DB
      .prepare(
        `SELECT s.*, i.id AS inq_id, i.status AS inq_status, i.linked_quote_id AS inq_quote_id
         FROM demand_signals s
         LEFT JOIN inquiries i ON i.id = s.linked_inquiry_id AND i.org_id = s.org_id
         WHERE s.org_id = ?`
      )
      .bind(ctx.orgId)
      .all();

    const taskRes = await env.DB
      .prepare(
        `SELECT id, platform, acquisition_mode, title, country_scope, product_keywords,
                hours_logged_tenths, actual_spend_minor, spend_currency, status, created_at, updated_at
         FROM discovery_tasks
         WHERE org_id = ?`
      )
      .bind(ctx.orgId)
      .all();

    // Helper: check if a task matches productFilter when specified
    const productMatchesTask = (t) => {
      if (!productFilter) return true;
      const hay = `${t.product_keywords || ""} ${t.title || ""}`.toLowerCase();
      if (!hay.trim()) return false;
      if (hay.includes(productFilter)) return true;
      const aliases = {
        valves: ["valve", "valves", "阀门"],
        pe_pipe: ["pe_pipe", "pe pipe", "hdpe", "pe100", "pipe", "管道"],
        cable: ["cable", "cables", "xlpe", "wire", "电缆"],
        steel_structure: ["steel", "steel_structure", "h-beam", "钢结构"],
      };
      const terms = aliases[productFilter] || [productFilter];
      return terms.some((term) => hay.includes(term));
    };

    // Helper: classify task country scope against countryFilter
    const classifyTaskCountry = (t) => {
      if (!countryFilter) return "direct_match";
      const rawScope = String(t.country_scope || "ANY").trim().toLowerCase();
      if (!rawScope || rawScope === "any" || rawScope === "all" || rawScope === "global") {
        return "shared_unallocated";
      }
      const tokens = rawScope
        .split(/[,;/|]+/)
        .map((x) => x.trim())
        .filter(Boolean);
      return tokens.includes(countryFilter) ? "direct_match" : "excluded";
    };

    const taskAgg = new Map();
    const sharedUnallocatedTasks = [];

    for (const t of taskRes.results || []) {
      // N03/N04: apply the SAME date window and product/country scope to tasks!
      const inDateWin = win.matches(t.created_at) || win.matches(t.updated_at);
      if (!inDateWin) continue;
      if (!productMatchesTask(t)) continue;

      const countryMatch = classifyTaskCountry(t);
      if (countryMatch === "excluded") continue;
      if (countryMatch === "shared_unallocated") {
        const spendObj =
          t.actual_spend_minor !== null && t.actual_spend_minor !== undefined && t.spend_currency
            ? {
                minor: Number(t.actual_spend_minor),
                currency: String(t.spend_currency).toUpperCase(),
                formatted: (() => {
                  try {
                    return formatMinor(t.actual_spend_minor, t.spend_currency);
                  } catch {
                    return `${t.spend_currency} ${t.actual_spend_minor}`;
                  }
                })(),
              }
            : null;
        sharedUnallocatedTasks.push({
          id: t.id,
          platform: t.platform,
          acquisition_mode: t.acquisition_mode,
          title: t.title,
          country_scope: t.country_scope || "ANY",
          hours_logged_tenths: Number(t.hours_logged_tenths || 0),
          spend: spendObj,
          effort_scope: "shared_unallocated",
        });
        continue;
      }

      const key = `${t.platform}::${t.acquisition_mode}`;
      if (!taskAgg.has(key)) {
        taskAgg.set(key, {
          platform: t.platform,
          acquisition_mode: t.acquisition_mode,
          task_count: 0,
          hours_logged_tenths: 0,
          spend_recorded_count: 0,
          spend_by_currency_big: new Map(),
          earliest_at: t.created_at || null,
          latest_at: t.updated_at || t.created_at || null,
        });
      }
      const g = taskAgg.get(key);
      g.task_count += 1;
      g.hours_logged_tenths += Number(t.hours_logged_tenths || 0);
      if (t.created_at && (!g.earliest_at || t.created_at < g.earliest_at)) g.earliest_at = t.created_at;
      const tLatest = t.updated_at || t.created_at;
      if (tLatest && (!g.latest_at || tLatest > g.latest_at)) g.latest_at = tLatest;

      // N02: Strictly aggregate spend per currency — NEVER sum USD cents + JPY yen together!
      if (t.actual_spend_minor !== null && t.actual_spend_minor !== undefined) {
        const curCode = String(t.spend_currency || "UNSPECIFIED").trim().toUpperCase() || "UNSPECIFIED";
        const minorBig = BigInt(Math.trunc(Number(t.actual_spend_minor) || 0));
        g.spend_recorded_count += 1;
        g.spend_by_currency_big.set(curCode, (g.spend_by_currency_big.get(curCode) || 0n) + minorBig);
      }
    }

    const round1Buckets = new Map();
    const futureCandidatesBuckets = new Map();

    const makeEmptyBucket = (platform, acqMode, earliestAt = null, latestAt = null) => ({
      source_platform: platform,
      acquisition_mode: acqMode,
      checked_candidates: 0,
      pending_verify_count: 0,
      verified_completed: 0,
      verified_valid: 0,
      drafts_generated: 0,
      copies_count: 0,
      manual_outreach_count: 0,
      replied_count: 0,
      inquiry_ids: new Set(),
      quoted_inquiry_ids: new Set(),
      earliest_at: earliestAt,
      latest_at: latestAt,
    });

    for (const s of sigRes.results || []) {
      if (!win.matches(s.discovered_at)) continue;
      if (countryFilter && String(s.country_en || "").toLowerCase() !== countryFilter) continue;
      if (productFilter && String(s.product_line || "").toLowerCase() !== productFilter) continue;

      const targetMap = s.source_platform === "youtube" ? futureCandidatesBuckets : round1Buckets;
      const key = `${s.source_platform}::${s.acquisition_mode}`;
      if (!targetMap.has(key)) {
        targetMap.set(key, makeEmptyBucket(s.source_platform, s.acquisition_mode, s.discovered_at, s.discovered_at));
      }
      const b = targetMap.get(key);
      b.checked_candidates += 1;
      if (!b.earliest_at || s.discovered_at < b.earliest_at) b.earliest_at = s.discovered_at;
      if (!b.latest_at || s.discovered_at > b.latest_at) b.latest_at = s.discovered_at;

      if (s.audit_status === "pending_verify") {
        b.pending_verify_count += 1;
      } else {
        b.verified_completed += 1;
        if (s.audit_status === "verified_valid" || s.audit_status === "approved") {
          b.verified_valid += 1;
        }
      }
      b.drafts_generated += Number(s.draft_count || 0);
      b.copies_count += Number(s.copy_count || 0);
      if (Number(s.manual_sent_count || 0) > 0) {
        b.manual_outreach_count += 1;
        if (s.replied_at) b.replied_count += 1;
      }
      if (s.inq_id) {
        b.inquiry_ids.add(s.inq_id);
        if (s.inq_status === "quoted") {
          b.quoted_inquiry_ids.add(s.inq_id);
        }
      }
    }

    // N03: Seed zero-yield discovery tasks (0 signals, >0 hours or spend) into buckets so wasted effort is NEVER hidden!
    for (const [key, t] of taskAgg.entries()) {
      const targetMap = t.platform === "youtube" ? futureCandidatesBuckets : round1Buckets;
      if (!targetMap.has(key)) {
        targetMap.set(key, makeEmptyBucket(t.platform, t.acquisition_mode, t.earliest_at, t.latest_at));
      }
    }

    const finalizeBuckets = (map) =>
      Array.from(map.entries()).map(([key, b]) => {
        const t = taskAgg.get(key);
        const verifiedValidRatePct =
          b.verified_completed > 0 ? Math.round((b.verified_valid / b.verified_completed) * 10000) / 100 : null;
        const replyRatePct =
          b.manual_outreach_count > 0 ? Math.round((b.replied_count / b.manual_outreach_count) * 10000) / 100 : null;

        const spendByCurrency = {};
        const currencyCodes = [];
        if (t && t.spend_by_currency_big.size > 0) {
          for (const [code, minorBig] of Array.from(t.spend_by_currency_big.entries()).sort((a, c) => a[0].localeCompare(c[0]))) {
            currencyCodes.push(code);
            let decimals = 2;
            let formatted = `${code} ${minorBig.toString()}`;
            try {
              const spec = getCurrencySpec(code);
              decimals = spec.decimals;
              formatted = `${spec.code} ${formatMinor(minorBig, spec.code)}`;
            } catch {}
            spendByCurrency[code] = {
              minor: Number(minorBig),
              decimals,
              formatted,
            };
          }
        }

        let spendStatus = "unknown_not_recorded";
        let actualSpendMinor = null;
        let spendCurrency = null;
        let spendDisplay = "未记录";
        if (currencyCodes.length === 1) {
          spendStatus = "recorded";
          spendCurrency = currencyCodes[0];
          actualSpendMinor = spendByCurrency[spendCurrency].minor;
          spendDisplay = spendByCurrency[spendCurrency].formatted;
        } else if (currencyCodes.length > 1) {
          spendStatus = "multi_currency_separate";
          spendCurrency = "MULTI";
          actualSpendMinor = null; // Explicitly null so no caller mixes USD cents + JPY yen!
          spendDisplay = currencyCodes.map((c) => spendByCurrency[c].formatted).join(" + ");
        }

        return {
          source_platform: b.source_platform,
          acquisition_mode: b.acquisition_mode,
          task_count: t ? t.task_count : 0,
          checked_candidates: b.checked_candidates,
          pending_verify_count: b.pending_verify_count,
          verified_completed: b.verified_completed,
          verified_valid: b.verified_valid,
          verified_valid_rate_pct: verifiedValidRatePct,
          drafts_generated: b.drafts_generated,
          copies_count: b.copies_count,
          manual_outreach_count: b.manual_outreach_count,
          replied_count: b.replied_count,
          reply_rate_pct: replyRatePct,
          inquiries_count: b.inquiry_ids.size,
          quoted_count: b.quoted_inquiry_ids.size,
          hours_logged_tenths: t ? t.hours_logged_tenths : null,
          actual_spend_minor: actualSpendMinor,
          spend_currency: spendCurrency,
          spend_by_currency: spendByCurrency,
          spend_display: spendDisplay,
          spend_status: spendStatus,
          zero_yield_task: b.checked_candidates === 0 && Boolean(t),
          sample_window: { earliest_at: b.earliest_at, latest_at: b.latest_at },
          small_sample_warning: b.checked_candidates < 20,
        };
      });

    return json(
      {
        ok: true,
        orgId: ctx.orgId,
        round1Platforms: ["facebook", "instagram", "linkedin"],
        excludedFromRound1: ["youtube"],
        observationWindow: {
          from: win.fromRaw,
          to: win.toRaw,
          tz_offset_minutes: win.tzOffsetMinutes,
          start_iso_utc: win.startIsoUtc,
          end_iso_utc: win.endIsoUtc,
          end_exclusive: win.endExclusive,
        },
        appliedFilters: {
          country: countryFilter || null,
          product_line: productFilter || null,
        },
        groups: finalizeBuckets(round1Buckets),
        futureCandidates: finalizeBuckets(futureCandidatesBuckets),
        sharedUnallocatedTasks,
        denominatorDefinitions: {
          verified_valid_rate_pct: "verified_valid / verified_completed (pending_verify excluded from denominator and listed separately)",
          reply_rate_pct: "replied_count / manual_outreach_count (drafts & copies strictly excluded from manual_outreach_count)",
          spend_by_currency: "strictly grouped per ISO currency; different currencies are NEVER summed together; empty/null means unknown_not_recorded",
          tasks_scope: "discovery_tasks filtered by the same observationWindow/country/product_line; zero-yield tasks are always displayed",
        },
      },
      200,
      cors
    );
  }

  // =========================================================================
  // 9. Inquiries & Verified Quote Linkage (ENG06 / ACQ10 / S06)
  // =========================================================================
  if (path === "/api/v3/inquiries" && method === "GET") {
    let sql = "SELECT * FROM inquiries WHERE org_id = ?";
    const binds = [ctx.orgId];
    if (isPartnerRole(ctx)) {
      sql += " AND (referrer_employee_id = ? OR primary_owner_id = ? OR id IN (SELECT inquiry_id FROM lead_assignments WHERE org_id = ? AND primary_assignee_id = ? AND assignment_status IN ('pending_accept','accepted') AND inquiry_id != ''))";
      binds.push(auth.actor.id, auth.actor.id, ctx.orgId, auth.actor.id);
    }
    sql += " ORDER BY created_at DESC LIMIT 200";
    const res = await env.DB.prepare(sql).bind(...binds).all();
    return json({ ok: true, inquiries: res.results || [] }, 200, cors);
  }

  const inqQuoteMatch = path.match(/^\/api\/v3\/inquiries\/([^/]+)\/quote$/);
  if (inqQuoteMatch && method === "POST") {
    if (!isInternalRole(ctx) && ctx.role !== "independent_user") {
      return json({ ok: false, code: "FORBIDDEN_OFFICIAL_QUOTE", error: "正式报价由公司官方团队或独立空间所有者出具与关联" }, 403, cors);
    }
    const inquiryId = decodeURIComponent(inqQuoteMatch[1]);
    const inq = await env.DB.prepare("SELECT * FROM inquiries WHERE id = ? AND org_id = ?").bind(inquiryId, ctx.orgId).first();
    if (!inq) return json({ ok: false, code: "INQUIRY_NOT_FOUND", error: "询盘不存在" }, 404, cors);

    // S06: Check linked company compliance / opt-out before issuing quote
    if (inq.company_id) {
      const cmp = await env.DB
        .prepare("SELECT opt_out_status, compliance_status FROM companies WHERE id = ? AND org_id = ?")
        .bind(inq.company_id, ctx.orgId)
        .first();
      if (cmp && (cmp.compliance_status === "blocked" || cmp.opt_out_status !== "none")) {
        return json(
          { ok: false, code: "COMPLIANCE_OR_OPTOUT_BLOCKED", error: "关联客户处于合规阻断或退订状态，禁止出具报价" },
          403,
          cors
        );
      }
    }

    const body = await parseJsonBody(request, 32768);

    // S06: Strict quote_tier, currency, total_minor, incoterm validation
    const quoteTier = String(body.quote_tier || "official").trim().toLowerCase();
    if (!VALID_QUOTE_TIERS.has(quoteTier)) {
      return json({ ok: false, code: "INVALID_QUOTE_TIER", error: "quote_tier 仅支持 indicative / official / formal" }, 400, cors);
    }
    let currencySpec;
    try {
      currencySpec = getCurrencySpec(body.currency || "USD");
    } catch {
      return json({ ok: false, code: "INVALID_CURRENCY", error: `不支持的报价币种 ${String(body.currency || "")}（仅支持 USD/CNY/EUR/GBP/JPY/AED/SAR）` }, 400, cors);
    }
    let totalMinorBig;
    try {
      totalMinorBig = parseExactSafeIntBigInt(body.total_minor, "total_minor", { allowNegative: false });
      if (totalMinorBig <= 0n) {
        return json({ ok: false, code: "INVALID_TOTAL_MINOR", error: "报价总额 total_minor 必须为大于 0 的精确最小货币单位整数" }, 400, cors);
      }
    } catch (err) {
      return json({ ok: false, code: "INVALID_TOTAL_MINOR", error: `报价总额 total_minor 无效：${err.message}` }, 400, cors);
    }

    const incoterm = String(body.incoterm || "FOB").trim().toUpperCase();
    if (!VALID_INCOTERMS.has(incoterm)) {
      return json({ ok: false, code: "INVALID_INCOTERM", error: `不支持的贸易术语 incoterm：${incoterm}` }, 400, cors);
    }

    // S06: Physically whitelist customer-facing item fields (strip factoryRmb, supplierCost, marginPct, internalNote, etc.)
    const sanitizedItems = [];
    if (body.items !== undefined) {
      if (!Array.isArray(body.items)) {
        return json({ ok: false, code: "INVALID_QUOTE_ITEMS", error: "items 必须为数组" }, 400, cors);
      }
      for (let idx = 0; idx < Math.min(body.items.length, 100); idx++) {
        const it = body.items[idx];
        if (!it || typeof it !== "object" || Array.isArray(it)) {
          return json({ ok: false, code: "INVALID_QUOTE_ITEMS", error: `第 ${idx + 1} 行报价明细对象无效` }, 400, cors);
        }
        const cleanItem = {
          sku: String(it.sku || "").trim().slice(0, 64),
          description: String(it.description || it.name || "").trim().slice(0, 200),
          spec: String(it.spec || "").trim().slice(0, 160),
          unit: String(it.unit || "pcs").trim().slice(0, 24),
        };
        if (it.qty !== undefined && it.qty !== null && it.qty !== "") {
          const qn = Number(it.qty);
          if (!Number.isFinite(qn) || qn <= 0) {
            return json({ ok: false, code: "INVALID_QUOTE_ITEMS", error: `第 ${idx + 1} 行数量 qty 必须大于 0` }, 400, cors);
          }
          cleanItem.qty = qn;
        }
        if (it.unit_price_minor !== undefined && it.unit_price_minor !== null && it.unit_price_minor !== "") {
          try {
            cleanItem.unit_price_minor = Number(parseExactSafeIntBigInt(it.unit_price_minor, "unit_price_minor", { allowNegative: false }));
          } catch {
            return json({ ok: false, code: "INVALID_QUOTE_ITEMS", error: `第 ${idx + 1} 行单价 unit_price_minor 须为非负整数` }, 400, cors);
          }
        }
        if (it.subtotal_minor !== undefined && it.subtotal_minor !== null && it.subtotal_minor !== "") {
          try {
            cleanItem.subtotal_minor = Number(parseExactSafeIntBigInt(it.subtotal_minor, "subtotal_minor", { allowNegative: false }));
          } catch {
            return json({ ok: false, code: "INVALID_QUOTE_ITEMS", error: `第 ${idx + 1} 行小计 subtotal_minor 须为非负整数` }, 400, cors);
          }
        }
        sanitizedItems.push(cleanItem);
      }
    }

    // S06: Draft vs Confirmed Sent — default sent_confirmed = 0 unless manager/owner explicitly passes confirm_approved: true
    const wantConfirm = body.confirm_approved === true;
    if (wantConfirm && !isManagerRole(ctx) && ctx.role !== "independent_user") {
      return json({ ok: false, code: "FORBIDDEN_QUOTE_CONFIRM", error: "仅主管/总负责人或独立空间所有者可确认正式发出报价" }, 403, cors);
    }
    const sentConfirmed = wantConfirm ? 1 : 0;
    const nextInqStatus = sentConfirmed === 1 ? "quoted" : inq.status === "quoted" ? "quoted" : "rfq_in_progress";

    const now = nowIso();
    const quoteId = randomId("qt");
    const refNo = String(body.ref_no || `FG-QT-${now.slice(0, 10).replace(/-/g, "")}-${randomHex(2).toUpperCase()}`).trim().slice(0, 64);

    // Strictly customer-facing payload with ZERO internal cost/margin fields
    const publicPayload = {
      inquiry_id: inquiryId,
      inquiry_no: inq.inquiry_no,
      currency: currencySpec.code,
      total_minor: Number(totalMinorBig),
      formatted_total: formatMinor(totalMinorBig, currencySpec.code),
      incoterm,
      valid_until: String(body.valid_until || addDaysIso(14)).slice(0, 40),
      items: sanitizedItems,
    };

    const stmts = [
      env.DB
        .prepare(
          `INSERT INTO quote_records (quote_id, org_id, company_id, ref_no, quote_tier, profile_version, payload_json, sent_confirmed, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'v3', ?, ?, ?, ?, ?)`
        )
        .bind(quoteId, ctx.orgId, inq.company_id || "unlinked_inquiry_buyer", refNo, quoteTier, JSON.stringify(publicPayload), sentConfirmed, auth.actor.id, now, now),
      env.DB
        .prepare("UPDATE inquiries SET status = ?, linked_quote_id = ?, updated_at = ? WHERE id = ? AND org_id = ?")
        .bind(nextInqStatus, quoteId, now, inquiryId, ctx.orgId),
    ];
    await executeAtomicBatch(env.DB, stmts);
    await writeAuditLog(env.DB, auth.actor, "V3_INQUIRY_QUOTED", "inquiry", inquiryId, `quote=${quoteId} ref=${refNo} sent=${sentConfirmed}`);
    return json(
      {
        ok: true,
        inquiry_id: inquiryId,
        quote_id: quoteId,
        ref_no: refNo,
        status: nextInqStatus,
        sent_confirmed: sentConfirmed,
        quote_status: sentConfirmed === 1 ? "confirmed_sent" : "draft_pending_approval",
        payload: publicPayload,
      },
      201,
      cors
    );
  }

  // =========================================================================
  // 10. Lightweight Projects & Multi-Company Buyer Roles (UX03 + REV01 cross-org guard)
  // =========================================================================
  if (path === "/api/v3/projects" && method === "GET") {
    const res = await env.DB
      .prepare("SELECT * FROM projects WHERE org_id = ? ORDER BY updated_at DESC LIMIT 100")
      .bind(ctx.orgId)
      .all();
    const partsRes = await env.DB
      .prepare(
        `SELECT pp.*, c.canonical_name AS company_name
         FROM project_participants pp
         LEFT JOIN companies c ON c.id = pp.company_id AND c.org_id = pp.org_id
         WHERE pp.org_id = ?`
      )
      .bind(ctx.orgId)
      .all();
    const partsByProj = new Map();
    for (const p of partsRes.results || []) {
      if (!partsByProj.has(p.project_id)) partsByProj.set(p.project_id, []);
      partsByProj.get(p.project_id).push(p);
    }
    return json(
      {
        ok: true,
        projects: (res.results || []).map((pr) => ({ ...pr, participants: partsByProj.get(pr.id) || [] })),
      },
      200,
      cors
    );
  }

  if (path === "/api/v3/projects" && method === "POST") {
    const body = await parseJsonBody(request, 16384);
    const title = String(body.title || "").trim();
    if (!title) return json({ ok: false, code: "PROJECT_TITLE_REQUIRED", error: "请填写项目名称" }, 400, cors);
    const now = nowIso();
    const id = randomId("prj");
    const projectCode = String(body.project_code || `PRJ-${now.slice(0, 10).replace(/-/g, "")}-${randomHex(2).toUpperCase()}`).trim();
    const readiness = VALID_READINESS.has(body.fulfillment_readiness) ? body.fulfillment_readiness : "needs_confirmation";
    await env.DB
      .prepare(
        `INSERT INTO projects (id, org_id, project_code, title, country_en, product_line, fulfillment_readiness, status, primary_owner_id, notes, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        ctx.orgId,
        projectCode,
        title.slice(0, 180),
        String(body.country_en || "").slice(0, 80),
        String(body.product_line || "").slice(0, 80),
        readiness,
        String(body.primary_owner_id || auth.actor.id).trim(),
        String(body.notes || "").slice(0, 1000),
        auth.actor.id,
        now,
        now
      )
      .run();
    return json({ ok: true, project: { id, org_id: ctx.orgId, project_code: projectCode, title, fulfillment_readiness: readiness } }, 201, cors);
  }

  const projPartMatch = path.match(/^\/api\/v3\/projects\/([^/]+)\/participants$/);
  if (projPartMatch && method === "POST") {
    const projectId = decodeURIComponent(projPartMatch[1]);
    const body = await parseJsonBody(request, 8192);
    const companyId = String(body.company_id || "").trim();
    const buyerRole = VALID_BUYER_ROLES.has(body.buyer_role) ? body.buyer_role : "unknown";

    // REV01 strict cross-org parent ID validation: BOTH project AND company MUST belong to ctx.orgId!
    const prj = await env.DB.prepare("SELECT id FROM projects WHERE id = ? AND org_id = ?").bind(projectId, ctx.orgId).first();
    if (!prj) return json({ ok: false, code: "RESOURCE_NOT_FOUND", error: "目标项目不存在" }, 404, cors);
    const cmp = await env.DB.prepare("SELECT id FROM companies WHERE id = ? AND org_id = ?").bind(companyId, ctx.orgId).first();
    if (!cmp) return json({ ok: false, code: "RESOURCE_NOT_FOUND", error: "关联企业不存在或无权跨组织绑定" }, 404, cors);

    const id = randomId("pp");
    const now = nowIso();
    await env.DB
      .prepare(
        `INSERT INTO project_participants (id, org_id, project_id, company_id, buyer_role, contact_name, contact_channel, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        ctx.orgId,
        projectId,
        companyId,
        buyerRole,
        String(body.contact_name || "").slice(0, 100),
        String(body.contact_channel || "").slice(0, 160),
        String(body.notes || "").slice(0, 500),
        now
      )
      .run();
    return json({ ok: true, participant: { id, org_id: ctx.orgId, project_id: projectId, company_id: companyId, buyer_role: buyerRole } }, 201, cors);
  }

  // =========================================================================
  // 11. 3-Tier Partner Deal Registration with Blind Dedupe & Protection Receipt (REV07/08, UX05)
  // =========================================================================
  if (path === "/api/v3/partner/deal-reg" && method === "POST") {
    const body = await parseJsonBody(request, 16384);
    const idemKey = String(request.headers.get("X-Idempotency-Key") || body.idem_key || "").trim();

    const idemRes = await runIdempotentOperation(env.DB, {
      orgId: ctx.orgId,
      actorId: auth.actor.id,
      scope: "v3_deal_reg_create",
      targetId: "",
      idemKey,
      requestBody: body,
      executor: async ({ idemKey: activeIdemKey }) => {
        if (activeIdemKey) {
          const existingByIdem = await env.DB
            .prepare("SELECT * FROM deal_registrations WHERE org_id = ? AND partner_employee_id = ? AND idem_key = ? LIMIT 1")
            .bind(ctx.orgId, auth.actor.id, activeIdemKey)
            .first();
          if (existingByIdem) {
            return {
              status: 201,
              body: {
                ok: true,
                registration: {
                  id: existingByIdem.id,
                  reg_no: existingByIdem.reg_no,
                  reg_tier: existingByIdem.reg_tier,
                  status: existingByIdem.status,
                  receipt_type: existingByIdem.receipt_type,
                  expectedFeedbackWindow: "1–2 个工作日内由内部主管完成盲查重与归属核验",
                  nextStep: "您无需重复提交；若需补充关系或项目证据，主管将在系统内给出明确补件提示。",
                },
              },
              commitStmts: [],
            };
          }
        }

        const regTier = String(body.reg_tier || "relationship_reg").trim();
        const companyName = String(body.company_name || "").trim();
        if (!VALID_REG_TIERS.has(regTier)) {
          return { status: 400, body: { ok: false, code: "INVALID_REG_TIER", error: "报备层级仅支持 relationship_reg / demand_reg / project_reg" } };
        }
        if (!companyName) {
          return { status: 400, body: { ok: false, code: "COMPANY_NAME_REQUIRED", error: "请填写报备客户企业名称" } };
        }
        if (regTier === "demand_reg" && !String(body.demand_evidence || "").trim()) {
          return { status: 400, body: { ok: false, code: "DEMAND_EVIDENCE_REQUIRED", error: "需求报备须提供需求证据说明" } };
        }
        if (regTier === "project_reg" && !String(body.project_title || "").trim()) {
          return { status: 400, body: { ok: false, code: "PROJECT_TITLE_REQUIRED", error: "项目报备须明确项目名称" } };
        }

        const normName = normalizeCompanyName(companyName);
        const dom = extractCleanDomain(body.website_domain || body.website || "");
        const websiteDomain = isPublicOrPlatformDomain(dom) ? "" : dom;
        const now = nowIso();
        const id = randomId("drg");
        const regNo = `FG-REG-${now.slice(0, 10).replace(/-/g, "")}-${randomHex(3).toUpperCase()}`;

        const insertStmt = env.DB
          .prepare(
            `INSERT INTO deal_registrations (
               id, org_id, reg_no, reg_tier, partner_employee_id, company_name, norm_name,
               country_en, website_domain, contact_channel, relationship_note, demand_evidence,
               project_title, status, receipt_type, idem_key, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_audit', 'intake_receipt', ?, ?, ?)`
          )
          .bind(
            id,
            ctx.orgId,
            regNo,
            regTier,
            auth.actor.id,
            companyName.slice(0, 160),
            normName,
            String(body.country_en || "").slice(0, 80),
            websiteDomain,
            String(body.contact_channel || "").slice(0, 160),
            String(body.relationship_note || "").slice(0, 500),
            String(body.demand_evidence || "").slice(0, 1000),
            String(body.project_title || "").slice(0, 180),
            activeIdemKey || "",
            now,
            now
          );

        // REV07 Blind Dedupe: ALWAYS return identical neutral receipt to partner — zero leakage of existing company/owner!
        return {
          status: 201,
          body: {
            ok: true,
            registration: {
              id,
              reg_no: regNo,
              reg_tier: regTier,
              status: "pending_audit",
              receipt_type: "intake_receipt",
              expectedFeedbackWindow: "1–2 个工作日内由内部主管完成盲查重与归属核验",
              nextStep: "您无需重复提交；若需补充关系或项目证据，主管将在系统内给出明确补件提示。",
            },
          },
          commitStmts: [insertStmt],
        };
      },
    });
    return json({ ...idemRes.body, replayed: Boolean(idemRes.replayed) }, idemRes.status, cors);
  }

  if (path === "/api/v3/partner/deal-reg" && method === "GET") {
    let rows = [];
    if (isManagerRole(ctx)) {
      const res = await env.DB
        .prepare("SELECT * FROM deal_registrations WHERE org_id = ? ORDER BY created_at DESC LIMIT 200")
        .bind(ctx.orgId)
        .all();
      // Manager receives internal duplicate collision hints for fair adjudication (REV07)
      rows = [];
      for (const r of res.results || []) {
        const hints = [];
        if (r.norm_name || r.website_domain) {
          const cmpHits = await env.DB
            .prepare(
              `SELECT id, canonical_name, primary_owner_id, source_contributor_id
               FROM companies
               WHERE org_id = ? AND deleted_at IS NULL AND (norm_name = ? OR (website_domain != '' AND website_domain = ?))
               LIMIT 5`
            )
            .bind(ctx.orgId, r.norm_name, r.website_domain || "__none__")
            .all();
          for (const c of cmpHits.results || []) {
            hints.push({ kind: "existing_company", company_id: c.id, canonical_name: c.canonical_name, primary_owner_id: c.primary_owner_id });
          }
        }
        rows.push({ ...r, duplicateHints: hints });
      }
    } else {
      // Partner sees ONLY their own registrations, with clear status & feedback (UX05) and ZERO other-partner leakage
      const res = await env.DB
        .prepare(
          `SELECT id, reg_no, reg_tier, company_name, country_en, project_title, status,
                  receipt_type, protection_cert_no, protection_starts_at, protection_expires_at,
                  canonical_sha256, review_note, created_at, updated_at
           FROM deal_registrations
           WHERE org_id = ? AND partner_employee_id = ?
           ORDER BY created_at DESC LIMIT 100`
        )
        .bind(ctx.orgId, auth.actor.id)
        .all();
      rows = res.results || [];
    }
    return json({ ok: true, registrations: rows }, 200, cors);
  }

  const regReviewMatch = path.match(/^\/api\/v3\/deal-reg\/([^/]+)\/review$/);
  if (regReviewMatch && method === "PATCH") {
    if (!isManagerRole(ctx)) {
      return json({ ok: false, code: "FORBIDDEN_DEAL_REG_REVIEW", error: "仅主管/总负责人可审批报备记录" }, 403, cors);
    }
    const regId = decodeURIComponent(regReviewMatch[1]);
    const reg = await env.DB.prepare("SELECT * FROM deal_registrations WHERE id = ? AND org_id = ?").bind(regId, ctx.orgId).first();
    if (!reg) return json({ ok: false, code: "DEAL_REG_NOT_FOUND", error: "报备记录不存在" }, 404, cors);

    const body = await parseJsonBody(request, 16384);
    const decision = String(body.decision || "").trim(); // 'approve' | 'need_more_info' | 'disputed' | 'rejected'
    const reviewNote = String(body.review_note || "").trim().slice(0, 500);
    const now = nowIso();

    let nextStatus = "pending_audit";
    let receiptType = "intake_receipt";
    let certNo = reg.protection_cert_no || "";
    let startsAt = reg.protection_starts_at || null;
    let expiresAt = reg.protection_expires_at || null;
    let scopeJson = reg.protection_scope_json || "{}";
    let canonicalSha = reg.canonical_sha256 || "";

    if (decision === "need_more_info" || decision === "disputed" || decision === "rejected") {
      nextStatus = decision;
    } else if (decision === "approve") {
      // REV08: If protectionDays is TBD (null), issue honest intake_receipt without fabricating binding protection days!
      const configuredDays = body.override_protection_days ?? ctx.orgSettings.protectionDays ?? null;
      const daysNum = configuredDays !== null && configuredDays !== "" ? Number(configuredDays) : null;
      if (daysNum && Number.isFinite(daysNum) && daysNum > 0) {
        nextStatus = "approved_protected";
        receiptType = "protection_record";
        certNo = `FG-CERT-${now.slice(0, 10).replace(/-/g, "")}-${randomHex(3).toUpperCase()}`;
        startsAt = now;
        expiresAt = addDaysIso(daysNum);
        const scopeObj = {
          reg_no: reg.reg_no,
          reg_tier: reg.reg_tier,
          company_name: reg.company_name,
          project_title: reg.project_title,
          partner_employee_id: reg.partner_employee_id,
          protection_days: daysNum,
          policy_version: String(body.policy_version || "v3-configured"),
          starts_at: startsAt,
          expires_at: expiresAt,
        };
        scopeJson = JSON.stringify(scopeObj);
        canonicalSha = await sha256Hex(scopeJson);
      } else {
        nextStatus = "approved_receipt";
        receiptType = "intake_receipt";
        const scopeObj = {
          reg_no: reg.reg_no,
          reg_tier: reg.reg_tier,
          company_name: reg.company_name,
          policy_notice: "protectionDays_TBD_intake_receipt_only",
          confirmed_at: now,
        };
        scopeJson = JSON.stringify(scopeObj);
        canonicalSha = await sha256Hex(scopeJson);
      }
    } else {
      return json({ ok: false, code: "INVALID_DECISION", error: "decision 仅支持 approve / need_more_info / disputed / rejected" }, 400, cors);
    }

    await env.DB
      .prepare(
        `UPDATE deal_registrations
         SET status = ?, receipt_type = ?, protection_cert_no = ?, protection_scope_json = ?,
             protection_starts_at = ?, protection_expires_at = ?, canonical_sha256 = ?,
             reviewed_by = ?, review_note = ?, updated_at = ?
         WHERE id = ? AND org_id = ?`
      )
      .bind(nextStatus, receiptType, certNo, scopeJson, startsAt, expiresAt, canonicalSha, auth.actor.id, reviewNote, now, regId, ctx.orgId)
      .run();

    await writeAuditLog(env.DB, auth.actor, "V3_DEAL_REG_REVIEWED", "deal_registration", regId, `status=${nextStatus} receipt=${receiptType}`);
    return json(
      {
        ok: true,
        id: regId,
        status: nextStatus,
        receipt_type: receiptType,
        protection_cert_no: certNo || null,
        protection_starts_at: startsAt,
        protection_expires_at: expiresAt,
        canonical_sha256: canonicalSha,
      },
      200,
      cors
    );
  }

  // =========================================================================
  // 12. ENG01 Atomic Dispatch (assign / accept / reject / reassign) & UX02 Today's Action Queue
  // =========================================================================
  if (path === "/api/v3/dispatch/assign" && method === "POST") {
    if (!isManagerRole(ctx)) {
      return json({ ok: false, code: "FORBIDDEN_DISPATCH", error: "仅主管/总负责人可执行派单分配" }, 403, cors);
    }
    const body = await parseJsonBody(request, 16384);
    const assignmentId = String(body.assignment_id || "").trim();
    const assigneeId = String(body.assignee_employee_id || "").trim();
    const idemKey = String(request.headers.get("X-Idempotency-Key") || body.idem_key || "").trim();

    if (!assignmentId || !assigneeId) {
      return json({ ok: false, code: "DISPATCH_FIELDS_REQUIRED", error: "assignment_id 与 assignee_employee_id 为必填项" }, 400, cors);
    }

    const idemRes = await runIdempotentOperation(env.DB, {
      orgId: ctx.orgId,
      actorId: auth.actor.id,
      scope: "v3_dispatch_assign",
      targetId: assignmentId,
      idemKey,
      requestBody: body,
      executor: async () => {
        const cur = await env.DB
          .prepare("SELECT * FROM lead_assignments WHERE id = ? AND org_id = ?")
          .bind(assignmentId, ctx.orgId)
          .first();
        if (!cur) return { status: 404, body: { ok: false, code: "ASSIGNMENT_NOT_FOUND", error: "派单任务不存在" } };
        if (!["pending_dispatch", "rejected", "reclaimed"].includes(cur.assignment_status)) {
          return { status: 409, body: { ok: false, code: "INVALID_ASSIGNMENT_STATE", error: `当前状态 ${cur.assignment_status} 不可直接派发，请使用转派接口` } };
        }

        // Verify target assignee is an active member of ctx.orgId
        const targetMem = await env.DB
          .prepare(
            `SELECT m.employee_id, m.lead_cap_inquiry, m.lead_cap_dev
             FROM org_memberships m
             JOIN employees e ON e.id = m.employee_id
             WHERE m.org_id = ? AND m.employee_id = ? AND m.status = 'active' AND e.status = 'active'
             LIMIT 1`
          )
          .bind(ctx.orgId, assigneeId)
          .first();
        let validAssignee = Boolean(targetMem);
        if (!validAssignee && ctx.orgId === "org_friesgo_main") {
          const legacyEmp = await env.DB
            .prepare("SELECT id FROM employees WHERE id = ? AND status = 'active' AND role IN ('super_admin','manager','staff')")
            .bind(assigneeId)
            .first();
          validAssignee = Boolean(legacyEmp);
        }
        if (!validAssignee) {
          return { status: 400, body: { ok: false, code: "INVALID_ASSIGNEE", error: "目标接单人不是当前组织空间的有效在职成员" } };
        }

        const now = nowIso();
        const opId = randomId("op");
        const acceptHours = body.accept_hours !== undefined ? Number(body.accept_hours) : ctx.orgSettings.defaultAcceptHours;
        const firstContactHours = body.first_contact_hours !== undefined ? Number(body.first_contact_hours) : ctx.orgSettings.defaultFirstContactHours;
        const acceptDeadlineAt = acceptHours && Number(acceptHours) > 0 ? addSecondsIso(Number(acceptHours) * 3600) : null;
        const firstContactDeadlineAt = firstContactHours && Number(firstContactHours) > 0 ? addSecondsIso(Number(firstContactHours) * 3600) : null;
        const slaTimezone = String(body.sla_timezone || "Asia/Singapore").slice(0, 64);

        const stmts = [
          env.DB
            .prepare(
              `UPDATE lead_assignments
               SET assignment_status = 'pending_accept',
                   primary_assignee_id = ?,
                   assigned_by = ?,
                   accept_deadline_at = ?,
                   first_contact_deadline_at = ?,
                   sla_timezone = ?,
                   last_op_id = ?,
                   version = version + 1,
                   updated_at = ?
               WHERE id = ? AND org_id = ? AND assignment_status = ? AND version = ?`
            )
            .bind(assigneeId, auth.actor.id, acceptDeadlineAt, firstContactDeadlineAt, slaTimezone, opId, now, assignmentId, ctx.orgId, cur.assignment_status, cur.version),
          env.DB
            .prepare(
              `INSERT INTO assignment_events (id, org_id, assignment_id, op_id, event_type, actor_id, from_assignee_id, to_assignee_id, reason, meta_json, created_at)
               SELECT ?, ?, ?, ?, 'dispatched', ?, ?, ?, ?, ?, ?
               WHERE EXISTS (
                 SELECT 1 FROM lead_assignments WHERE id = ? AND org_id = ? AND last_op_id = ? AND assignment_status = 'pending_accept'
               )`
            )
            .bind(
              randomId("aev"),
              ctx.orgId,
              assignmentId,
              opId,
              auth.actor.id,
              cur.primary_assignee_id || "",
              assigneeId,
              String(body.reason || "supervisor_dispatched").slice(0, 200),
              JSON.stringify({ slaTimezone, acceptDeadlineAt }),
              now,
              assignmentId,
              ctx.orgId,
              opId
            ),
        ];

        const batchRes = await executeAtomicBatch(env.DB, stmts);
        const updated = Number((batchRes[0] && batchRes[0].meta && batchRes[0].meta.changes) || 0);
        const inserted = Number((batchRes[1] && batchRes[1].meta && batchRes[1].meta.changes) || 0);
        if (updated !== 1 || inserted !== 1) {
          return { status: 409, body: { ok: false, code: "ASSIGNMENT_CONFLICT", error: "派单状态已发生并发变更，请刷新后重试" } };
        }
        return {
          status: 200,
          body: {
            ok: true,
            assignment_id: assignmentId,
            assignment_status: "pending_accept",
            primary_assignee_id: assigneeId,
            op_id: opId,
            version: Number(cur.version) + 1,
          },
        };
      },
    });
    return json({ ...idemRes.body, replayed: Boolean(idemRes.replayed) }, idemRes.status, cors);
  }

  // ENG01 Atomic Accept (proves op_id conditional side-effect inside single DB.batch!)
  const acceptMatch = path.match(/^\/api\/v3\/dispatch\/([^/]+)\/accept$/);
  if (acceptMatch && method === "POST") {
    const assignmentId = decodeURIComponent(acceptMatch[1]);
    const body = await parseJsonBody(request, 8192);
    const idemKey = String(request.headers.get("X-Idempotency-Key") || body.idem_key || "").trim();

    const idemRes = await runIdempotentOperation(env.DB, {
      orgId: ctx.orgId,
      actorId: auth.actor.id,
      scope: "v3_dispatch_accept",
      targetId: assignmentId,
      idemKey,
      requestBody: body,
      executor: async () => {
        const cur = await env.DB
          .prepare("SELECT * FROM lead_assignments WHERE id = ? AND org_id = ?")
          .bind(assignmentId, ctx.orgId)
          .first();
        if (!cur) return { status: 404, body: { ok: false, code: "ASSIGNMENT_NOT_FOUND", error: "派单任务不存在" } };
        if (cur.primary_assignee_id !== auth.actor.id && !isManagerRole(ctx)) {
          return { status: 403, body: { ok: false, code: "NOT_ASSIGNEE", error: "仅指定接单人可确认接单" } };
        }
        if (cur.assignment_status !== "pending_accept") {
          return { status: 409, body: { ok: false, code: "ASSIGNMENT_ALREADY_HANDLED", error: `当前派单状态为 ${cur.assignment_status}，不可重复接单` } };
        }

        const expectedVersion = body.version !== undefined ? Number(body.version) : Number(cur.version);
        const now = nowIso();
        const opId = randomId("op");

        const stmts = [
          env.DB
            .prepare(
              `UPDATE lead_assignments
               SET assignment_status = 'accepted',
                   last_op_id = ?,
                   version = version + 1,
                   updated_at = ?
               WHERE id = ? AND org_id = ? AND assignment_status = 'pending_accept' AND version = ?`
            )
            .bind(opId, now, assignmentId, ctx.orgId, expectedVersion),
          env.DB
            .prepare(
              `INSERT INTO assignment_events (id, org_id, assignment_id, op_id, event_type, actor_id, from_assignee_id, to_assignee_id, reason, meta_json, created_at)
               SELECT ?, ?, ?, ?, 'accepted', ?, ?, ?, 'assignee_accepted', '{}', ?
               WHERE EXISTS (
                 SELECT 1 FROM lead_assignments
                 WHERE id = ? AND org_id = ? AND last_op_id = ? AND assignment_status = 'accepted'
               )`
            )
            .bind(
              randomId("aev"),
              ctx.orgId,
              assignmentId,
              opId,
              auth.actor.id,
              cur.primary_assignee_id,
              cur.primary_assignee_id,
              now,
              assignmentId,
              ctx.orgId,
              opId
            ),
        ];

        const batchRes = await executeAtomicBatch(env.DB, stmts);
        const updated = Number((batchRes[0] && batchRes[0].meta && batchRes[0].meta.changes) || 0);
        const inserted = Number((batchRes[1] && batchRes[1].meta && batchRes[1].meta.changes) || 0);
        if (updated !== 1 || inserted !== 1) {
          return { status: 409, body: { ok: false, code: "ASSIGNMENT_CONFLICT", error: "派单已被其他并发操作更新，未产生重复事件" } };
        }

        return {
          status: 200,
          body: {
            ok: true,
            assignment_id: assignmentId,
            assignment_status: "accepted",
            op_id: opId,
            version: expectedVersion + 1,
          },
        };
      },
    });
    return json({ ...idemRes.body, replayed: Boolean(idemRes.replayed) }, idemRes.status, cors);
  }

  // Atomic Reject
  const rejectMatch = path.match(/^\/api\/v3\/dispatch\/([^/]+)\/reject$/);
  if (rejectMatch && method === "POST") {
    const assignmentId = decodeURIComponent(rejectMatch[1]);
    const body = await parseJsonBody(request, 8192);
    const reason = String(body.reason || "").trim();
    if (!reason) return json({ ok: false, code: "REJECT_REASON_REQUIRED", error: "拒单须说明原因以便主管快速改派" }, 400, cors);

    const cur = await env.DB.prepare("SELECT * FROM lead_assignments WHERE id = ? AND org_id = ?").bind(assignmentId, ctx.orgId).first();
    if (!cur) return json({ ok: false, code: "ASSIGNMENT_NOT_FOUND", error: "派单任务不存在" }, 404, cors);
    if (cur.primary_assignee_id !== auth.actor.id && !isManagerRole(ctx)) {
      return json({ ok: false, code: "NOT_ASSIGNEE", error: "仅指定接单人或主管可拒单" }, 403, cors);
    }
    if (cur.assignment_status !== "pending_accept") {
      return json({ ok: false, code: "INVALID_ASSIGNMENT_STATE", error: `当前状态 ${cur.assignment_status} 不可拒单` }, 409, cors);
    }

    const now = nowIso();
    const opId = randomId("op");
    const batchRes = await executeAtomicBatch(env.DB, [
      env.DB
        .prepare(
          `UPDATE lead_assignments
           SET assignment_status = 'rejected', loss_reason = ?, last_op_id = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND org_id = ? AND assignment_status = 'pending_accept' AND version = ?`
        )
        .bind(reason.slice(0, 300), opId, now, assignmentId, ctx.orgId, cur.version),
      env.DB
        .prepare(
          `INSERT INTO assignment_events (id, org_id, assignment_id, op_id, event_type, actor_id, from_assignee_id, to_assignee_id, reason, meta_json, created_at)
           SELECT ?, ?, ?, ?, 'rejected', ?, ?, '', ?, '{}', ?
           WHERE EXISTS (SELECT 1 FROM lead_assignments WHERE id = ? AND org_id = ? AND last_op_id = ? AND assignment_status = 'rejected')`
        )
        .bind(randomId("aev"), ctx.orgId, assignmentId, opId, auth.actor.id, cur.primary_assignee_id, reason.slice(0, 300), now, assignmentId, ctx.orgId, opId),
    ]);
    if (Number((batchRes[0] && batchRes[0].meta && batchRes[0].meta.changes) || 0) !== 1) {
      return json({ ok: false, code: "ASSIGNMENT_CONFLICT", error: "状态已变更，请刷新" }, 409, cors);
    }
    return json({ ok: true, assignment_id: assignmentId, assignment_status: "rejected", op_id: opId }, 200, cors);
  }

  // Atomic Reassign (ENG06 preserves full history in assignment_events)
  const reassignMatch = path.match(/^\/api\/v3\/dispatch\/([^/]+)\/reassign$/);
  if (reassignMatch && method === "POST") {
    if (!isManagerRole(ctx)) {
      return json({ ok: false, code: "FORBIDDEN_REASSIGN", error: "仅主管/总负责人可执行转派" }, 403, cors);
    }
    const assignmentId = decodeURIComponent(reassignMatch[1]);
    const body = await parseJsonBody(request, 8192);
    const toAssignee = String(body.to_assignee_id || "").trim();
    const reason = String(body.reason || "supervisor_reassigned").trim();
    if (!toAssignee) return json({ ok: false, code: "ASSIGNEE_REQUIRED", error: "请指定新接单人 to_assignee_id" }, 400, cors);

    const cur = await env.DB.prepare("SELECT * FROM lead_assignments WHERE id = ? AND org_id = ?").bind(assignmentId, ctx.orgId).first();
    if (!cur) return json({ ok: false, code: "ASSIGNMENT_NOT_FOUND", error: "派单任务不存在" }, 404, cors);

    const now = nowIso();
    const opId = randomId("op");
    const batchRes = await executeAtomicBatch(env.DB, [
      env.DB
        .prepare(
          `UPDATE lead_assignments
           SET assignment_status = 'pending_accept', primary_assignee_id = ?, assigned_by = ?, last_op_id = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND org_id = ? AND version = ?`
        )
        .bind(toAssignee, auth.actor.id, opId, now, assignmentId, ctx.orgId, cur.version),
      env.DB
        .prepare(
          `INSERT INTO assignment_events (id, org_id, assignment_id, op_id, event_type, actor_id, from_assignee_id, to_assignee_id, reason, meta_json, created_at)
           SELECT ?, ?, ?, ?, 'reassigned', ?, ?, ?, ?, '{}', ?
           WHERE EXISTS (SELECT 1 FROM lead_assignments WHERE id = ? AND org_id = ? AND last_op_id = ?)`
        )
        .bind(randomId("aev"), ctx.orgId, assignmentId, opId, auth.actor.id, cur.primary_assignee_id || "", toAssignee, reason.slice(0, 300), now, assignmentId, ctx.orgId, opId),
    ]);
    if (Number((batchRes[0] && batchRes[0].meta && batchRes[0].meta.changes) || 0) !== 1) {
      return json({ ok: false, code: "ASSIGNMENT_CONFLICT", error: "并发冲突，请刷新重试" }, 409, cors);
    }
    return json({ ok: true, assignment_id: assignmentId, primary_assignee_id: toAssignee, assignment_status: "pending_accept", op_id: opId }, 200, cors);
  }

  // UX02: Today's Action Queue + Personal WeChat Desensitized Copy Card
  if (path === "/api/v3/dispatch/my-todos" && method === "GET") {
    const scopeAll = isManagerRole(ctx) && url.searchParams.get("scope") === "all";
    let sql = `
      SELECT a.*,
             s.source_platform, s.acquisition_mode, s.country_en AS sig_country, s.product_line AS sig_product,
             s.demand_summary, s.contact_result, s.next_action, s.next_action_due_at,
             s.draft_count, s.copy_count, s.manual_sent_count, s.fulfillment_readiness,
             i.inquiry_no, i.status AS inquiry_status,
             p.title AS project_title,
             c.canonical_name AS company_name
      FROM lead_assignments a
      LEFT JOIN demand_signals s ON s.id = a.signal_id AND s.org_id = a.org_id
      LEFT JOIN inquiries i ON i.id = a.inquiry_id AND i.org_id = a.org_id
      LEFT JOIN projects p ON p.id = a.project_id AND p.org_id = a.org_id
      LEFT JOIN companies c ON c.id = a.company_id AND c.org_id = a.org_id
      WHERE a.org_id = ?
    `;
    const binds = [ctx.orgId];
    if (!scopeAll) {
      sql += " AND a.primary_assignee_id = ?";
      binds.push(auth.actor.id);
    }
    sql += " ORDER BY a.updated_at DESC LIMIT 100";
    const res = await env.DB.prepare(sql).bind(...binds).all();

    const rawPublicBase = String(
      (env && env.PUBLIC_APP_URL) ||
        (ctx.orgSettings && ctx.orgSettings.publicAppUrl) ||
        "https://jasunmr389-ship-it.github.io/friesgo-market/"
    ).trim();
    const publicBase = rawPublicBase.endsWith("/") ? rawPublicBase : `${rawPublicBase}/`;

    const items = (res.results || []).map((r) => {
      let bucket = "to_first_contact";
      if (r.assignment_status === "pending_accept" || r.assignment_status === "pending_dispatch") {
        bucket = "pending_accept_or_dispatch";
      } else if (r.inquiry_status === "need_specs" || r.contact_result === "need_specs") {
        bucket = "need_specs";
      } else if (r.inquiry_status === "open" || r.inquiry_status === "rfq_in_progress") {
        bucket = "waiting_internal_quote";
      } else if (r.contact_result === "manual_sent" || r.contact_result === "waiting_reply") {
        bucket = "waiting_buyer_reply";
      }

      const deepLinkUrl = `${publicBase}index.html?v3_org=${encodeURIComponent(ctx.orgId)}&v3_todo=${encodeURIComponent(r.id)}#v3-todo=${encodeURIComponent(r.id)}`;

      // N08: Personal WeChat desensitized copy card with full clickable HTTPS deep link (zero customer phone/email/price/credentials!)
      const wechatSafeCard = [
        `【FriesGo 待办提醒】${r.inquiry_no || r.id}`,
        `国家/产品：${r.sig_country || "待核实"} | ${r.sig_product || "待确认品类"}`,
        `当前状态：${r.assignment_status} / ${r.contact_result || r.business_stage}`,
        `摘要(已脱敏)：${redactPii(String(r.demand_summary || r.project_title || "").slice(0, 120))}`,
        `下一步：${r.next_action || (r.assignment_status === "pending_accept" ? "请登录工作台确认接单" : "请按规范跟进并登记联系结果")}`,
        `直达链接：${deepLinkUrl}`,
      ].join("\n");

      return { ...r, action_bucket: bucket, deepLinkUrl, wechatSafeCard };
    });

    // Assignment history count summary (ENG06)
    const evCountRow = await env.DB
      .prepare("SELECT event_type, COUNT(*) AS cnt FROM assignment_events WHERE org_id = ? GROUP BY event_type")
      .bind(ctx.orgId)
      .all();

    return json(
      {
        ok: true,
        orgId: ctx.orgId,
        todos: items,
        assignmentEventStats: evCountRow.results || [],
      },
      200,
      cors
    );
  }

  // =========================================================================
  // 13. ENG03 / S04 Auth-Proxied Sensitive Attachments (Zero Presigned URLs; Immediate 401 on Revoke; Partner Least-Privilege Visibility)
  // =========================================================================
  if (path === "/api/v3/attachments" && method === "POST") {
    const body = await parseJsonBody(request, 512 * 1024);
    const filename = String(body.filename || "evidence.txt").trim().slice(0, 120);
    const contentType = String(body.content_type || "text/plain; charset=utf-8").trim().slice(0, 80);
    const entityType = String(body.entity_type || "demand_signal").trim().slice(0, 40);
    const entityId = String(body.entity_id || "").trim().slice(0, 80);
    if (!VALID_ATTACH_ENTITY_TYPES.has(entityType)) {
      return json({ ok: false, code: "INVALID_ENTITY_TYPE", error: "不支持的附件关联业务类型" }, 400, cors);
    }
    let contentB64 = String(body.content_b64 || "").trim();
    if (!contentB64 && typeof body.content_text === "string") {
      contentB64 = bytesToBase64(new TextEncoder().encode(body.content_text));
    }
    if (!contentB64 || !entityId) {
      return json({ ok: false, code: "ATTACHMENT_INVALID", error: "缺少附件内容或关联 entity_id" }, 400, cors);
    }
    // S04: Partner can ONLY upload attachments to entities they own or are actively assigned to
    if (isPartnerRole(ctx)) {
      const canAttach = await canPartnerAccessEntity(env.DB, ctx, auth.actor.id, entityType, entityId);
      if (!canAttach) {
        return json({ ok: false, code: "RESOURCE_NOT_FOUND", error: "关联业务对象不存在或无权上传附件" }, 404, cors);
      }
    }
    const rawBytes = base64ToBytes(contentB64);
    if (rawBytes.length > 262144) {
      return json({ ok: false, code: "ATTACHMENT_TOO_LARGE", error: "首阶段单附件上限为 256 KB" }, 413, cors);
    }
    // S04: Default visibility is 'internal_only' for internal/owner uploads; partner uploads default 'org_authorized'
    const requestedVis = String(body.visibility || "").trim();
    const visibility = isPartnerRole(ctx)
      ? "org_authorized"
      : requestedVis === "org_authorized"
      ? "org_authorized"
      : "internal_only";

    const sha = await sha256Hex(contentB64);
    const id = randomId("att");
    const now = nowIso();
    const expiresAt = body.expires_days ? addDaysIso(Math.min(365, Math.max(1, Number(body.expires_days)))) : addDaysIso(90);

    await env.DB
      .prepare(
        `INSERT INTO attachments_meta (id, org_id, entity_type, entity_id, filename, content_type, size_bytes, sha256, content_b64, visibility, uploaded_by, expires_at, deleted_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
      )
      .bind(id, ctx.orgId, entityType, entityId, filename, contentType, rawBytes.length, sha, contentB64, visibility, auth.actor.id, expiresAt, now)
      .run();

    return json(
      {
        ok: true,
        attachment: {
          id,
          org_id: ctx.orgId,
          entity_type: entityType,
          entity_id: entityId,
          visibility,
          filename,
          content_type: contentType,
          size_bytes: rawBytes.length,
          sha256: sha,
          downloadPath: `/api/v3/attachments/${id}`,
          accessModel: "worker_auth_proxied_no_presigned_url",
        },
      },
      201,
      cors
    );
  }

  const attachGetMatch = path.match(/^\/api\/v3\/attachments\/([^/]+)$/);
  if (attachGetMatch && method === "GET") {
    const attachId = decodeURIComponent(attachGetMatch[1]);
    const row = await env.DB
      .prepare("SELECT * FROM attachments_meta WHERE id = ? AND org_id = ? AND deleted_at IS NULL")
      .bind(attachId, ctx.orgId)
      .first();
    if (!row || !(await canActorAccessAttachment(env.DB, ctx, auth.actor.id, row))) {
      return json({ ok: false, code: "ATTACHMENT_NOT_FOUND", error: "附件不存在或无权访问" }, 404, cors);
    }
    if (row.expires_at && row.expires_at <= nowIso()) {
      return json({ ok: false, code: "ATTACHMENT_EXPIRED", error: "附件已超过保存期限" }, 410, cors);
    }
    const bytes = base64ToBytes(row.content_b64 || "");
    return new Response(bytes, {
      status: 200,
      headers: {
        ...cors,
        "Content-Type": row.content_type || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${String(row.filename || "file").replace(/"/g, "")}"`,
        "Cache-Control": "no-store, no-cache, must-revalidate, private",
        "X-Content-Type-Options": "nosniff",
        "X-FG-Access-Model": "worker-auth-proxied",
      },
    });
  }

  return null;
}
