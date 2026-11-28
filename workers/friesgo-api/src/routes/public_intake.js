// FriesGo Global V3.0 Slice 1 - Public Intake Routes (Zero Private Data Leakage)
// Implements:
//   - GET  /api/public/catalog (NEW01 approved specs/certs + REV06 safe ref display without leaking disabled reason)
//   - POST /api/public/applications (REV09 3-way intake + ENG04 idempotency-before-Turnstile + one-time lookup_secret)
//   - POST /api/public/applications/status (ENG04 constant-time non-enumerable status check)
//   - POST /api/public/rfq (UX01 progressive minimal buyer RFQ + REV06 non-blocking referral touchpoint + ENG06 inquiry entity)

import { checkSystemMaintenanceGate } from "../auth.js";
import { randomHex, randomId, sha256Hex, timingSafeEqualStr } from "../crypto.js";
import { addSecondsIso, getClientIp, json, nowIso, parseJsonBody, safeJsonParse } from "../utils.js";

const VALID_APP_TYPES = new Set(["partner", "tool_trial", "team_career"]);
const VALID_PARTNER_MODES = new Set(["", "referrer", "followup"]);
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

const APP_STATUS_LABELS = {
  submitted: "已提交，待初审 / Submitted",
  pending_review: "资料复核中 / Under Review",
  interviewing: "沟通与面谈中 / Interviewing",
  need_more_info: "需补充资料 / More Info Needed",
  approved: "初审通过，待培训与激活 / Approved (Pending Onboarding)",
  rejected: "暂未通过 / Not Selected",
  training: "规范培训与考核中 / Onboarding & Quiz",
  active: "已激活 / Active",
  closed: "已关闭 / Closed",
};

const APP_NEXT_STEPS = {
  submitted: "官方运营团队将在 1–3 个工作日内完成资料初审，请通过原登记联系方式留意通知。",
  pending_review: "主管正在核对您的市场、语言或试用需求，请保持原登记联系方式畅通。",
  interviewing: "请按约定时间完成沟通，确认合作边界与首批业务安排。",
  need_more_info: "请查看补充说明并通过官方联系渠道提供相应信息。",
  approved: "初审已通过！主管将安排规范培训与账号开通，正式激活后方可进入对应数据空间。",
  rejected: "感谢关注 FriesGo Global，当前阶段暂未匹配，欢迎后续再次联系。",
  training: "请完成平台合规与基础业务考核，通过后主管将为您正式激活权限。",
  active: "您的账号已正式激活，可使用官方下发的登录账号进入工作台。",
  closed: "该申请流程已归档关闭。",
};

function canonicalStringify(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonicalStringify).join(",") + "]";
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalStringify(obj[k])).join(",") + "}";
}

async function verifyTurnstileIfConfigured(request, env, token) {
  const secret = String((env && env.TURNSTILE_SECRET_KEY) || "").trim();
  if (!secret) {
    return { ok: true, mode: "not_configured" };
  }
  const cleanToken = String(token || "").trim();
  if (!cleanToken) {
    return { ok: false, code: "TURNSTILE_REQUIRED", error: "请完成人机验证后再提交" };
  }
  if (typeof env.__TURNSTILE_VERIFY_FN === "function") {
    const res = await env.__TURNSTILE_VERIFY_FN(cleanToken, getClientIp(request));
    return res && res.ok
      ? { ok: true, mode: "verified_hook" }
      : { ok: false, code: "TURNSTILE_VERIFICATION_FAILED", error: "人机验证未通过或已过期，请刷新验证后重试" };
  }
  try {
    const form = new URLSearchParams();
    form.set("secret", secret);
    form.set("response", cleanToken);
    form.set("remoteip", getClientIp(request));
    const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    const data = await resp.json();
    if (data && data.success) return { ok: true, mode: "cloudflare_turnstile" };
    return { ok: false, code: "TURNSTILE_VERIFICATION_FAILED", error: "人机验证未通过或已过期，请刷新验证后重试" };
  } catch {
    return { ok: false, code: "TURNSTILE_UNAVAILABLE", error: "人机验证服务暂不可达，请稍后重试（已保留表单内容）" };
  }
}

async function checkPublicIdemBeforeTurnstile(db, scope, idemKey, reqHash) {
  const cleanKey = String(idemKey || "").trim();
  if (!cleanKey) return { hit: false };
  const row = await db
    .prepare(
      `SELECT request_sha256, state, response_status, response_json, lease_expires_at
       FROM idempotency_keys
       WHERE org_id = 'public' AND actor_id = 'anon' AND scope = ? AND target_id = '' AND idem_key = ?`
    )
    .bind(scope, cleanKey)
    .first();
  if (!row) return { hit: false };
  if (row.request_sha256 !== reqHash) {
    return {
      hit: true,
      status: 409,
      body: {
        ok: false,
        code: "IDEMPOTENCY_PAYLOAD_MISMATCH",
        error: "同一提交编号不允许更改提交内容，请刷新页面后发起新提交",
      },
    };
  }
  if (row.state === "completed") {
    const cached = safeJsonParse(row.response_json, {});
    return {
      hit: true,
      status: 200,
      body: {
        ...cached,
        ok: true,
        replayed: true,
      },
    };
  }
  if (row.state === "in_progress" && row.lease_expires_at > nowIso()) {
    return {
      hit: true,
      status: 409,
      body: {
        ok: false,
        code: "IDEMPOTENCY_IN_PROGRESS",
        error: "您的请求正在处理中，请稍候片刻勿重复点击",
      },
    };
  }
  return { hit: false, expiredInProgress: true };
}

async function acquirePublicIdemLease(db, scope, idemKey, reqHash, expiredInProgress) {
  const cleanKey = String(idemKey || "").trim();
  if (!cleanKey) return { ok: true };
  const now = nowIso();
  const leaseUntil = addSecondsIso(30);
  if (expiredInProgress) {
    const res = await db
      .prepare(
        `UPDATE idempotency_keys
         SET lease_expires_at = ?, updated_at = ?
         WHERE org_id = 'public' AND actor_id = 'anon' AND scope = ? AND target_id = '' AND idem_key = ? AND state = 'in_progress' AND lease_expires_at <= ?`
      )
      .bind(leaseUntil, now, scope, cleanKey, now)
      .run();
    if (Number((res && res.meta && res.meta.changes) || 0) !== 1) {
      return { ok: false };
    }
    return { ok: true };
  }
  try {
    await db
      .prepare(
        `INSERT INTO idempotency_keys (org_id, actor_id, scope, target_id, idem_key, request_sha256, state, response_status, response_json, lease_expires_at, created_at, updated_at)
         VALUES ('public', 'anon', ?, '', ?, ?, 'in_progress', 0, '{}', ?, ?, ?)`
      )
      .bind(scope, cleanKey, reqHash, leaseUntil, now, now)
      .run();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

function buildCompletePublicIdemStmt(db, scope, idemKey, status, safeBodyObj) {
  const cleanKey = String(idemKey || "").trim();
  if (!cleanKey) return null;
  return db
    .prepare(
      `UPDATE idempotency_keys
       SET state = 'completed', response_status = ?, response_json = ?, updated_at = ?
       WHERE org_id = 'public' AND actor_id = 'anon' AND scope = ? AND target_id = '' AND idem_key = ?`
    )
    .bind(status, JSON.stringify(safeBodyObj), nowIso(), scope, cleanKey);
}

async function releasePublicIdem(db, scope, idemKey) {
  const cleanKey = String(idemKey || "").trim();
  if (!cleanKey) return;
  try {
    await db
      .prepare(
        `DELETE FROM idempotency_keys
         WHERE org_id = 'public' AND actor_id = 'anon' AND scope = ? AND target_id = '' AND idem_key = ? AND state = 'in_progress'`
      )
      .bind(scope, cleanKey)
      .run();
  } catch {}
}

export async function handlePublicIntakeRoutes(request, env, cors, url) {
  const path = url.pathname;
  const method = request.method;

  if (!path.startsWith("/api/public/")) return null;

  // Fail-Closed check: never accept public writes or serve stale data during restore freeze
  const gate = await checkSystemMaintenanceGate(env.DB);
  if (!gate.allowed) {
    return json(
      { ok: false, code: gate.code || "SYSTEM_RESTORE_FROZEN", error: "系统维护中，请稍后再试" },
      503,
      cors
    );
  }

  // 1. GET /api/public/catalog (?ref=optional_partner_ref)
  if (path === "/api/public/catalog" && method === "GET") {
    const now = nowIso();
    const mainOrg = await env.DB
      .prepare("SELECT name, settings_json FROM orgs WHERE id = 'org_friesgo_main' AND status = 'active'")
      .first();
    const settings = safeJsonParse(mainOrg && mainOrg.settings_json, {});

    const catRes = await env.DB
      .prepare(
        `SELECT category_key, title_en, title_cn, supply_status, approved_specs_json, verified_certs_json, moq_note, catalog_version, approved_at, review_due_at
         FROM product_catalog_approvals
         WHERE org_id = 'org_friesgo_main' AND approved_at IS NOT NULL AND (review_due_at IS NULL OR review_due_at > ?)
         ORDER BY category_key ASC`
      )
      .bind(now)
      .all();

    const categories = (catRes.results || []).map((r) => ({
      category_key: r.category_key,
      title_en: r.title_en,
      title_cn: r.title_cn,
      supply_status: r.supply_status,
      approved_specs: safeJsonParse(r.approved_specs_json, {}),
      verified_certs: safeJsonParse(r.verified_certs_json, []),
      moq_note: r.moq_note || "",
      catalog_version: Number(r.catalog_version || 1),
      approved_at: r.approved_at,
    }));

    const refParam = String(url.searchParams.get("ref") || "").trim();
    let referral = null;
    if (refParam) {
      const refRow = await env.DB
        .prepare(
          `SELECT m.partner_ref_code, m.partner_approved_title
           FROM org_memberships m
           JOIN employees e ON e.id = m.employee_id
           WHERE m.org_id = 'org_friesgo_main' AND m.partner_ref_code = ? AND m.status = 'active' AND e.status = 'active'
           LIMIT 1`
        )
        .bind(refParam)
        .first();
      if (refRow) {
        referral = {
          refValid: true,
          refCode: refRow.partner_ref_code,
          displayTitle: refRow.partner_approved_title || "Authorized Partner Contact",
          officialDisclaimerCn: "正式报价、合同签署、指定账户收款与交付均由 FriesGo Global 官方统一负责。",
          officialDisclaimerEn: "Official quotations, contracts, payment collection, and delivery are handled solely by FriesGo Global.",
        };
      } else {
        // REV06: Neutral fallback — NEVER expose whether ref was disabled, suspended, or nonexistent!
        referral = {
          refValid: false,
        };
      }
    }

    return json(
      {
        ok: true,
        exporter: {
          brandName: settings.exporterBrandName || (mainOrg && mainOrg.name) || "FriesGo Global",
          publicContactHint: settings.publicContactHint || "Official Export Desk",
        },
        categories,
        referral,
      },
      200,
      cors
    );
  }

  // 2. POST /api/public/applications (3-way intake: partner / tool_trial / team_career)
  if (path === "/api/public/applications" && method === "POST") {
    const body = await parseJsonBody(request, 65536);
    const appType = String(body.app_type || "").trim();
    const partnerMode = String(body.partner_mode || "").trim();
    const applicantName = String(body.applicant_name || "").trim();
    const countryTz = String(body.country_tz || "").trim();
    const languages = String(body.languages || "").trim();
    const contactChannel = String(body.contact_channel || "").trim();
    const contactValue = String(body.contact_value || "").trim();
    const productLines = Array.isArray(body.product_lines)
      ? body.product_lines.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 20)
      : [];
    const summaryObj = body.summary && typeof body.summary === "object" && !Array.isArray(body.summary) ? body.summary : {};
    const privacyConsent = body.privacyConsent === true;
    const marketingOptIn = body.marketingOptIn === true;
    const idemKey = String(request.headers.get("X-Idempotency-Key") || body.idem_key || "").trim() || randomId("pubapp");

    if (!VALID_APP_TYPES.has(appType)) {
      return json({ ok: false, code: "INVALID_APP_TYPE", error: "请选择有效的申请类型（partner / tool_trial / team_career）" }, 400, cors);
    }
    if (appType === "partner" && !VALID_PARTNER_MODES.has(partnerMode)) {
      return json({ ok: false, code: "INVALID_PARTNER_MODE", error: "伙伴模式仅支持 referrer 或 followup" }, 400, cors);
    }
    if (!applicantName || applicantName.length > 120) {
      return json({ ok: false, code: "APPLICANT_NAME_REQUIRED", error: "请填写您的姓名或称呼（1–120 字符）" }, 400, cors);
    }
    if (!contactChannel || !contactValue || contactValue.length > 160) {
      return json({ ok: false, code: "CONTACT_REQUIRED", error: "请提供至少一个有效的联系渠道及联系方式" }, 400, cors);
    }
    if (!privacyConsent) {
      return json(
        { ok: false, code: "PRIVACY_CONSENT_REQUIRED", error: "须先阅读并勾选同意《隐私与申请数据处理声明》方可提交" },
        400,
        cors
      );
    }

    // Hash canonical business payload (excluding turnstile_token so lost-receipt retries match cleanly)
    const canonicalPayload = {
      app_type: appType,
      partner_mode: appType === "partner" ? partnerMode : "",
      applicant_name: applicantName,
      country_tz: countryTz,
      languages,
      contact_channel: contactChannel,
      contact_value: contactValue,
      product_lines: productLines,
      summary: summaryObj,
      privacyConsent: true,
      marketingOptIn,
    };
    const reqHash = await sha256Hex(canonicalStringify(canonicalPayload));

    // ENG04 Step 1: Check completed idempotent record BEFORE Turnstile!
    const preCheck = await checkPublicIdemBeforeTurnstile(env.DB, "public_application", idemKey, reqHash);
    if (preCheck.hit) {
      return json(preCheck.body, preCheck.status, cors);
    }

    // ENG04 Step 2: Verify Turnstile only for genuinely new submissions
    const tsCheck = await verifyTurnstileIfConfigured(request, env, body.turnstile_token);
    if (!tsCheck.ok) {
      return json({ ok: false, code: tsCheck.code, error: tsCheck.error }, 403, cors);
    }

    const lease = await acquirePublicIdemLease(env.DB, "public_application", idemKey, reqHash, Boolean(preCheck.expiredInProgress));
    if (!lease.ok) {
      return json({ ok: false, code: "IDEMPOTENCY_IN_PROGRESS", error: "相同申请正在处理中，请稍候片刻" }, 409, cors);
    }

    try {
      const now = nowIso();
      const id = randomId("app");
      const ymd = now.slice(0, 10).replace(/-/g, "");
      const applicationNo = `FG-APP-${ymd}-${randomHex(3).toUpperCase()}`;
      const lookupSecret = `fglk_${randomHex(18)}`;
      const lookupSecretHash = await sha256Hex(`${applicationNo}:${lookupSecret}`);

      // Safe cached replay body: NEVER store lookup_secret or applicant PII in idempotency_keys!
      const safeReplayBody = {
        ok: true,
        application_no: applicationNo,
        app_type: appType,
        status: "submitted",
        statusLabel: APP_STATUS_LABELS.submitted,
        nextStep: APP_NEXT_STEPS.submitted,
        lookupSecretNotice:
          "查询密钥仅在首次创建成功时明文展示一次；若因断网未保存，请使用原登记联系方式联系官方运营人工核验重置。",
      };

      const insertAppStmt = env.DB
        .prepare(
          `INSERT INTO applications (
             id, application_no, lookup_secret_hash, idem_key, app_type, partner_mode,
             applicant_name, country_tz, languages, contact_channel, contact_value,
             product_lines_json, summary_json, privacy_consent_at, marketing_opt_in,
             status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?)`
        )
        .bind(
          id,
          applicationNo,
          lookupSecretHash,
          idemKey,
          appType,
          appType === "partner" ? partnerMode : "",
          applicantName,
          countryTz.slice(0, 100),
          languages.slice(0, 120),
          contactChannel.slice(0, 40),
          contactValue.slice(0, 160),
          JSON.stringify(productLines),
          JSON.stringify(summaryObj),
          now,
          marketingOptIn ? 1 : 0,
          now,
          now
        );
      const completeStmt = buildCompletePublicIdemStmt(env.DB, "public_application", idemKey, 201, safeReplayBody);
      const batchStmts = completeStmt ? [insertAppStmt, completeStmt] : [insertAppStmt];
      if (typeof env.DB.batch === "function") {
        await env.DB.batch(batchStmts);
      } else {
        for (const s of batchStmts) await s.run();
      }

      return json(
        {
          ...safeReplayBody,
          replayed: false,
          lookup_secret: lookupSecret,
          lookupSecretUsage: "该密钥仅本次明文展示一次，但保存后可反复用于查询审批进度。",
        },
        201,
        cors
      );
    } catch (err) {
      await releasePublicIdem(env.DB, "public_application", idemKey);
      throw err;
    }
  }

  // 3. POST /api/public/applications/status (ENG04 constant-time non-enumerable lookup)
  if (path === "/api/public/applications/status" && method === "POST") {
    const body = await parseJsonBody(request, 8192);
    const applicationNo = String(body.application_no || "").trim();
    const lookupSecret = String(body.lookup_secret || "").trim();
    if (!applicationNo || !lookupSecret) {
      return json({ ok: false, code: "APPLICATION_NOT_FOUND", error: "申请编号或查询密钥不匹配" }, 404, cors);
    }

    const row = await env.DB
      .prepare(
        `SELECT application_no, lookup_secret_hash, app_type, status, review_note, updated_at
         FROM applications
         WHERE application_no = ?
         LIMIT 1`
      )
      .bind(applicationNo)
      .first();

    const candidateHash = await sha256Hex(`${applicationNo}:${lookupSecret}`);
    const matched = Boolean(row && timingSafeEqualStr(row.lookup_secret_hash, candidateHash));
    if (!matched) {
      return json({ ok: false, code: "APPLICATION_NOT_FOUND", error: "申请编号或查询密钥不匹配" }, 404, cors);
    }

    return json(
      {
        ok: true,
        application_no: row.application_no,
        app_type: row.app_type,
        status: row.status,
        statusLabel: APP_STATUS_LABELS[row.status] || row.status,
        nextStep: APP_NEXT_STEPS[row.status] || "",
        publicNote: row.status === "need_more_info" || row.status === "rejected" ? row.review_note || "" : "",
        updated_at: row.updated_at,
      },
      200,
      cors
    );
  }

  // 4. POST /api/public/rfq (UX01 minimal buyer RFQ + REV06 pending ref touchpoint)
  if (path === "/api/public/rfq" && method === "POST") {
    const body = await parseJsonBody(request, 65536);
    const demandSummary = String(body.demandSummary || body.demand_summary || "").trim();
    const countryEn = String(body.country_en || body.country || "").trim();
    const contactChannel = String(body.contactChannel || body.contact_channel || "").trim();
    const contactValue = String(body.contactValue || body.contact_value || "").trim();
    const privacyConsent = body.privacyConsent === true;
    const marketingOptIn = body.marketingOptIn === true;

    const companyName = String(body.companyName || body.company_name || "").trim();
    const contactName = String(body.contactName || body.contact_name || "").trim();
    const productLine = String(body.productLine || body.product_line || "unspecified").trim();
    const quantity = String(body.quantity || "unknown").trim();
    const destinationPort = String(body.destinationPort || body.destination_port || "unknown").trim();
    const targetTimeline = String(body.targetTimeline || body.target_timeline || "unknown").trim();
    const specsObj = body.specs && typeof body.specs === "object" && !Array.isArray(body.specs) ? body.specs : {};
    const refCode = String(body.ref || "").trim();
    const rawPlatform = String(body.sourcePlatform || body.source_platform || "website").trim().toLowerCase();
    const sourcePlatform = VALID_SIGNAL_PLATFORMS.has(rawPlatform) ? rawPlatform : "website";
    const sourceTaskId = String(body.sourceTaskId || body.source_task_id || "").trim().slice(0, 64);
    const sourceSignalId = String(body.sourceSignalId || body.source_signal_id || "").trim().slice(0, 64);
    const idemKey = String(request.headers.get("X-Idempotency-Key") || body.idem_key || "").trim() || randomId("pubrfq");

    if (demandSummary.length < 5 || demandSummary.length > 2000) {
      return json({ ok: false, code: "DEMAND_SUMMARY_REQUIRED", error: "请简要描述您的产品或项目需求（至少 5 个字符）" }, 400, cors);
    }
    if (!countryEn || countryEn.length > 80) {
      return json({ ok: false, code: "COUNTRY_REQUIRED", error: "请填写所在国家或项目目标地区" }, 400, cors);
    }
    if (!contactChannel || !contactValue || contactValue.length > 160) {
      return json({ ok: false, code: "CONTACT_REQUIRED", error: "请提供一个可联系渠道与联系方式" }, 400, cors);
    }
    if (!privacyConsent) {
      return json({ ok: false, code: "PRIVACY_CONSENT_REQUIRED", error: "请勾选同意隐私声明后提交询价" }, 400, cors);
    }

    const canonicalPayload = {
      demandSummary,
      country_en: countryEn,
      contactChannel,
      contactValue,
      companyName,
      contactName,
      productLine,
      quantity,
      destinationPort,
      targetTimeline,
      specs: specsObj,
      ref: refCode,
      sourcePlatform,
      sourceTaskId,
      sourceSignalId,
      privacyConsent: true,
      marketingOptIn,
    };
    const reqHash = await sha256Hex(canonicalStringify(canonicalPayload));

    // Check completed idempotency BEFORE Turnstile
    const preCheck = await checkPublicIdemBeforeTurnstile(env.DB, "public_rfq", idemKey, reqHash);
    if (preCheck.hit) {
      return json(preCheck.body, preCheck.status, cors);
    }

    const tsCheck = await verifyTurnstileIfConfigured(request, env, body.turnstile_token);
    if (!tsCheck.ok) {
      return json({ ok: false, code: tsCheck.code, error: tsCheck.error }, 403, cors);
    }

    const lease = await acquirePublicIdemLease(env.DB, "public_rfq", idemKey, reqHash, Boolean(preCheck.expiredInProgress));
    if (!lease.ok) {
      return json({ ok: false, code: "IDEMPOTENCY_IN_PROGRESS", error: "询价请求正在提交，请稍候" }, 409, cors);
    }

    try {
      // REV06: Resolve optional referral strictly as pending touchpoint; invalid/disabled ref NEVER blocks buyer RFQ!
      let referrerEmployeeId = "";
      let acquisitionMode = "owned_account_inquiry";
      let refRecorded = false;
      if (refCode) {
        const refRow = await env.DB
          .prepare(
            `SELECT m.employee_id
             FROM org_memberships m
             JOIN employees e ON e.id = m.employee_id
             WHERE m.org_id = 'org_friesgo_main' AND m.partner_ref_code = ? AND m.status = 'active' AND e.status = 'active'
             LIMIT 1`
          )
          .bind(refCode)
          .first();
        if (refRow && refRow.employee_id) {
          referrerEmployeeId = refRow.employee_id;
          acquisitionMode = "partner_referral";
          refRecorded = true;
        }
      }

      const now = nowIso();
      const ymd = now.slice(0, 10).replace(/-/g, "");
      const signalId = randomId("sig");
      const inquiryId = randomId("inq");
      const inquiryNo = `FG-RFQ-${ymd}-${randomHex(3).toUpperCase()}`;
      const assignmentId = randomId("asg");
      const opId = randomId("op");

      const missingFields = [];
      if (!companyName) missingFields.push("company_name");
      if (!quantity || quantity.toLowerCase() === "unknown") missingFields.push("quantity");
      if (!destinationPort || destinationPort.toLowerCase() === "unknown") missingFields.push("destination_port");
      if (!specsObj || Object.keys(specsObj).length === 0) missingFields.push("technical_specs");

      const inquiryStatus = missingFields.length >= 2 ? "need_specs" : "open";
      const fullSpecs = {
        quantity,
        destinationPort,
        targetTimeline,
        companyName: companyName || "unknown",
        contactName: contactName || "unknown",
        marketingOptIn,
        refCodeProvided: refCode ? true : false,
        refRecorded,
        sourceSignalIdHint: sourceSignalId || "",
        ...specsObj,
      };

      const safeResp = {
        ok: true,
        inquiry_no: inquiryNo,
        status: inquiryStatus,
        refRecorded,
        missingFieldsHint: missingFields,
        nextStepCn: "已收到您的采购需求！官方团队将在工作时段通过您提供的渠道核对缺失规格并安排正式报价。",
        nextStepEn: "Your inquiry has been received. Our export engineering desk will contact you via your chosen channel to confirm any missing specs and issue an official quotation.",
      };

      const stmts = [
        env.DB
          .prepare(
            `INSERT INTO demand_signals (
               id, org_id, task_id, source_platform, acquisition_mode, signal_tier,
               source_url, external_id, published_at, discovered_at, last_verified_at,
               language, country_en, product_line, fulfillment_readiness, company_name,
               buyer_role, contact_name, contact_channel, demand_summary, usage_license_scope,
               ai_inferred_fields_json, judgment_tags_json, missing_info_json,
               audit_status, audit_reason, contact_result, idem_key, referrer_employee_id, linked_inquiry_id,
               created_by, created_at, updated_at
             ) VALUES (?, 'org_friesgo_main', ?, ?, ?, 'direct_inquiry', '', ?, ?, ?, ?, ?, ?, ?, 'needs_confirmation', ?, 'buyer', ?, ?, ?, 'buyer_direct_submission', '{}', ?, ?, 'verified_valid', 'buyer_rfq_direct', 'converted_inquiry', ?, ?, ?, 'public_rfq', ?, ?)`
          )
          .bind(
            signalId,
            sourceTaskId,
            sourcePlatform,
            acquisitionMode,
            inquiryNo,
            now,
            now,
            now,
            String(body.language || "").slice(0, 32),
            countryEn.slice(0, 80),
            productLine.slice(0, 80),
            companyName.slice(0, 120),
            contactName.slice(0, 100),
            `${contactChannel.slice(0, 30)}:${contactValue.slice(0, 140)}`,
            demandSummary,
            JSON.stringify({
              clarity: missingFields.length <= 1 ? "clear" : "partial_needs_specs",
              timeliness: "fresh_direct_submission",
              buyerRoleConfidence: "direct_buyer_submitted",
            }),
            JSON.stringify(missingFields),
            idemKey,
            referrerEmployeeId,
            inquiryId,
            now,
            now
          ),
        env.DB
          .prepare(
            `INSERT INTO inquiries (
               id, org_id, inquiry_no, company_id, project_id, source_signal_id,
               source_platform, acquisition_mode, country_en, product_line, summary,
               specs_json, contact_channel, contact_value, referrer_employee_id,
               primary_owner_id, status, created_by, created_at, updated_at
             ) VALUES (?, 'org_friesgo_main', ?, '', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, 'public_rfq', ?, ?)`
          )
          .bind(
            inquiryId,
            inquiryNo,
            signalId,
            sourcePlatform,
            acquisitionMode,
            countryEn.slice(0, 80),
            productLine.slice(0, 80),
            demandSummary,
            JSON.stringify(fullSpecs),
            contactChannel.slice(0, 40),
            contactValue.slice(0, 160),
            referrerEmployeeId,
            inquiryStatus,
            now,
            now
          ),
        env.DB
          .prepare(
            `INSERT INTO lead_assignments (
               id, org_id, inquiry_id, signal_id, lead_kind, assignment_status, business_stage,
               source_contributor_id, last_op_id, version, created_at, updated_at
             ) VALUES (?, 'org_friesgo_main', ?, ?, 'valid_inquiry', 'pending_dispatch', 'inquired', ?, ?, 1, ?, ?)`
          )
          .bind(assignmentId, inquiryId, signalId, referrerEmployeeId, opId, now, now),
        env.DB
          .prepare(
            `INSERT INTO assignment_events (
               id, org_id, assignment_id, op_id, event_type, actor_id, reason, meta_json, created_at
             ) VALUES (?, 'org_friesgo_main', ?, ?, 'created', 'public_rfq', 'direct_rfq_intake', ?, ?)`
          )
          .bind(randomId("aev"), assignmentId, opId, JSON.stringify({ inquiryNo, acquisitionMode, refRecorded }), now),
      ];
      const completeStmt = buildCompletePublicIdemStmt(env.DB, "public_rfq", idemKey, 201, safeResp);
      if (completeStmt) stmts.push(completeStmt);

      if (typeof env.DB.batch === "function") {
        await env.DB.batch(stmts);
      } else {
        for (const s of stmts) await s.run();
      }

      return json({ ...safeResp, replayed: false }, 201, cors);
    } catch (err) {
      await releasePublicIdem(env.DB, "public_rfq", idemKey);
      throw err;
    }
  }

  return null;
}
