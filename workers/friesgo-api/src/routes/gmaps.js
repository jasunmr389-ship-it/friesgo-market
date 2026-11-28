// Employee-Authenticated Paid Google Places API (New) Proxy
// Enforces:
//   1. Mandatory verified employee session (401 for unauthenticated external visitors).
//   2. Atomic per-employee AND team monthly hard caps in D1 BEFORE calling upstream Google API.
//   3. places.id included in FIELD_MASK (Terms 3.2.3 Place ID exemption); NEVER caches or stores Google business fields in D1.
//   4. Cache-Control: no-store on all responses.

import { requireLegacyMainInternal } from "../auth.js";
import { json, nowIso, parseJsonBody, writeAuditLog } from "../utils.js";

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.rating",
  "places.userRatingCount",
  "places.googleMapsUri",
  "places.primaryTypeDisplayName",
  "nextPageToken",
].join(",");

async function reserveQuotaAtomic(db, quotaKey, ym, scope, cap) {
  const now = nowIso();
  // Ensure row exists idempotently
  await db
    .prepare(
      `INSERT OR IGNORE INTO gmaps_quota_usage (quota_key, ym, scope, used, cap, updated_at)
       VALUES (?, ?, ?, 0, ?, ?)`
    )
    .bind(quotaKey, ym, scope, cap, now)
    .run();
  // Atomic conditional increment: only increments if used < cap
  const won = await db
    .prepare(
      `UPDATE gmaps_quota_usage
       SET used = used + 1, cap = ?, updated_at = ?
       WHERE quota_key = ? AND used < ?
       RETURNING used, cap`
    )
    .bind(cap, now, quotaKey, cap)
    .first();
  if (won) return { allowed: true, used: Number(won.used), cap: Number(won.cap) };
  const cur = await db.prepare("SELECT used, cap FROM gmaps_quota_usage WHERE quota_key = ?").bind(quotaKey).first();
  return { allowed: false, used: Number((cur && cur.used) || cap), cap };
}

export async function handleGmapsRoutes(request, env, cors, url) {
  // Authoritative server-side quota status for logged-in members (D12)
  if (url.pathname === "/api/gmaps/quota" && request.method === "GET") {
    const auth = await requireLegacyMainInternal(request, env, cors);
    if (!auth.ok) return auth.response;
    const ym = nowIso().slice(0, 7);
    const teamCap = Math.min(2000, Math.max(1, parseInt(env.GMAPS_TEAM_MONTHLY_CAP || "950", 10) || 950));
    const rawEmpCap = auth.actor.gmaps_monthly_cap;
    const empCap = rawEmpCap === undefined || rawEmpCap === null || rawEmpCap === ""
      ? Math.min(teamCap, parseInt(env.GMAPS_EMP_MONTHLY_CAP || "250", 10) || 250)
      : Math.min(teamCap, Math.max(0, Number(rawEmpCap)));
    const empRow = await env.DB
      .prepare("SELECT used FROM gmaps_quota_usage WHERE quota_key = ?")
      .bind(`emp:${auth.actor.id}:${ym}`)
      .first();
    const teamRow = await env.DB
      .prepare("SELECT used FROM gmaps_quota_usage WHERE quota_key = ?")
      .bind(`team:${ym}`)
      .first();
    const empUsed = Number((empRow && empRow.used) || 0);
    const teamUsed = Number((teamRow && teamRow.used) || 0);
    return json(
      {
        ok: true,
        ym,
        model: "d1_atomic_member_and_team",
        apiKeyConfigured: Boolean(env.GOOGLE_MAPS_API_KEY),
        empUsed,
        empCap,
        empRemaining: Math.max(0, empCap - empUsed),
        teamUsed,
        teamCap,
        teamRemaining: Math.max(0, teamCap - teamUsed),
        warnThreshold: Math.floor(teamCap * 0.73),
        highThreshold: Math.floor(teamCap * 0.94),
      },
      200,
      cors
    );
  }

  if (url.pathname !== "/api/gmaps/search" || request.method !== "POST") return null;

  const auth = await requireLegacyMainInternal(request, env, cors);
  if (!auth.ok) return auth.response;

  const ym = nowIso().slice(0, 7);
  const teamCap = Math.min(2000, Math.max(1, parseInt(env.GMAPS_TEAM_MONTHLY_CAP || "950", 10) || 950));
  const rawEmpCap = auth.actor.gmaps_monthly_cap;
  const empCap = rawEmpCap === undefined || rawEmpCap === null || rawEmpCap === ""
    ? Math.min(teamCap, parseInt(env.GMAPS_EMP_MONTHLY_CAP || "250", 10) || 250)
    : Math.min(teamCap, Math.max(0, Number(rawEmpCap)));

  // D07: Enforce 0 quota strictly BEFORE checking upstream key or making ANY Google request!
  if (empCap <= 0) {
    return json({ error: "当前账号 Google Maps 月度可用额度为 0（已禁用付费权限），请联系总负责人开通", code: "EMP_QUOTA_DISABLED" }, 403, cors);
  }

  if (!env.GOOGLE_MAPS_API_KEY) {
    return json({ error: "服务端尚未配置 GOOGLE_MAPS_API_KEY 密钥，请联系总负责人配置后使用", code: "GMAPS_NOT_CONFIGURED" }, 503, cors);
  }

  const body = await parseJsonBody(request, 16384);
  const textQuery = String(body.textQuery || "").trim().slice(0, 180);
  if (!textQuery) return json({ error: "缺少搜索关键词 textQuery" }, 400, cors);

  // Reserve per-employee quota first, then team quota
  const empRes = await reserveQuotaAtomic(env.DB, `emp:${auth.actor.id}:${ym}`, ym, `employee:${auth.actor.login_id}`, empCap);
  if (!empRes.allowed) {
    return json(
      {
        error: `⛔ 个人月度配额已达上限（${empRes.used}/${empRes.cap} 次），已拦截本次请求防止超额计费`,
        code: "EMP_QUOTA_EXCEEDED",
        empUsed: empRes.used,
        empCap: empRes.cap,
      },
      429,
      cors
    );
  }

  const teamRes = await reserveQuotaAtomic(env.DB, `team:${ym}`, ym, "team", teamCap);
  if (!teamRes.allowed) {
    // Refund the employee counter since team cap blocked BEFORE calling Google upstream
    await env.DB
      .prepare("UPDATE gmaps_quota_usage SET used = MAX(0, used - 1), updated_at = ? WHERE quota_key = ?")
      .bind(nowIso(), `emp:${auth.actor.id}:${ym}`)
      .run();
    return json(
      {
        error: `⛔ 团队本月 Google Places 配额已达硬上限（${teamRes.used}/${teamRes.cap} 次），已熔断拦截`,
        code: "TEAM_QUOTA_EXCEEDED",
        quotaUsed: teamRes.used,
        quotaCap: teamRes.cap,
      },
      429,
      cors
    );
  }

  const pageSize = Math.min(20, Math.max(5, parseInt(body.pageSize || 20, 10) || 20));
  const payload = { textQuery, pageSize };
  if (body.pageToken) payload.pageToken = String(body.pageToken).slice(0, 512);

  await writeAuditLog(
    env.DB,
    auth.actor,
    "GMAPS_SEARCH",
    "gmaps_quota",
    `team:${ym}`,
    `query=${textQuery.slice(0, 80)}; emp=${empRes.used}/${empRes.cap}; team=${teamRes.used}/${teamRes.cap}`
  );

  // Allow test mock hook in unit tests without hitting real Google network
  const fetchImpl = typeof env._mockGmapsFetch === "function" ? env._mockGmapsFetch : fetch;
  let gRes;
  try {
    gRes = await fetchImpl("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": env.GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return json(
      {
        error: "连接 Google Places 上游失败（已预扣配额以防重复计费）：" + String(err),
        quotaUsed: teamRes.used,
        quotaCap: teamRes.cap,
        empUsed: empRes.used,
        empCap: empRes.cap,
      },
      502,
      cors
    );
  }

  const rawText = await gRes.text();
  let data = {};
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    return json({ error: `Google Places 上游返回非 JSON (HTTP ${gRes.status})` }, 502, cors);
  }

  let quotaNotice = "";
  if (teamRes.used >= Math.floor(teamCap * 0.94)) {
    quotaNotice = `⚠️ 高水位预警：团队本月已用 ${teamRes.used}/${teamRes.cap} 次（个人 ${empRes.used}/${empRes.cap}）`;
  } else if (teamRes.used >= Math.floor(teamCap * 0.73)) {
    quotaNotice = `ℹ️ 用量提醒：团队本月已用 ${teamRes.used}/${teamRes.cap} 次（个人 ${empRes.used}/${empRes.cap}）`;
  }

  return json(
    {
      places: data.places || [],
      nextPageToken: data.nextPageToken || "",
      error: data.error ? data.error.message : "",
      quotaUsed: teamRes.used,
      quotaCap: teamRes.cap,
      empUsed: empRes.used,
      empCap: empRes.cap,
      quotaNotice,
    },
    gRes.ok ? 200 : gRes.status,
    cors
  );
}
