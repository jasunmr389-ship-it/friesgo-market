/**
 * FriesGo Global - Cloudflare Worker Proxy for Google Maps Places API (New)
 *
 * Security, Atomic Metering & Billing Architecture (Phase 1 Hardened):
 *   1. Keeps GOOGLE_MAPS_API_KEY strictly in Cloudflare Secrets (never exposed to clients).
 *   2. Enforces mandatory TEAM_PASS secret with constant-time comparison (503 if unset, 401 if invalid).
 *      Note: Browser Origin validation + shared team password stops casual abuse and cross-site reuse,
 *      but Origin headers can be spoofed outside browsers (Origin != cryptographic user identity).
 *   3. Enforces strict 403 when ALLOWED_ORIGIN is configured and Origin does not match allowlist.
 *   4. Uses Cloudflare Durable Object `QuotaLimiter` (env.QUOTA_LIMITER) to atomically pre-reserve
 *      monthly team quota BEFORE calling upstream Google Places API:
 *      - Default tiers: 700 (info), 900 (high-usage warning), 950 (hard monthly block, HTTP 429).
 *      - Fail-closed (HTTP 503) if QuotaLimiter binding is missing or throws storage errors (unless
 *        ALLOW_UNMETERED_DEV === "true" is explicitly set for local dev).
 *      - Validates method, Origin, auth, and JSON payload BEFORE reserving quota so invalid requests
 *        do not consume quota; NEVER refunds quota once upstream fetch begins (upstream failures may
 *        still be billed by Google).
 *   5. Google Cloud Console Note: Google Cloud provides per-day / per-minute API rate quotas and
 *      Billing Budget Alerts (not a native monthly 950 hard switch); configure daily caps + budget
 *      alerts in Google Cloud Console alongside this Durable Object monthly hard cap.
 */

const DEFAULT_WARN_INFO = 700;
const DEFAULT_WARN_HIGH = 900;
const DEFAULT_HARD_CAP = 950;

const FIELD_MASK = [
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

function parseAllowedOrigins(env) {
  const raw = String((env && env.ALLOWED_ORIGIN) || "").trim();
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function buildCorsHeaders(request, env) {
  const reqOrigin = request.headers.get("Origin") || "";
  const allowedList = parseAllowedOrigins(env);
  let allowOrigin = "*";
  if (allowedList.length > 0) {
    allowOrigin = allowedList.includes(reqOrigin) ? reqOrigin : "null";
  }
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Team-Pass",
    "Vary": "Origin",
  };
}

function timingSafeEqualStr(a, b) {
  const enc = new TextEncoder();
  const aBytes = enc.encode(String(a || ""));
  const bBytes = enc.encode(String(b || ""));
  const maxLen = Math.max(aBytes.length, bBytes.length, 1);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < maxLen; i++) {
    const av = i < aBytes.length ? aBytes[i] : 0;
    const bv = i < bBytes.length ? bBytes[i] : 0;
    diff |= av ^ bv;
  }
  return diff === 0 && aBytes.length > 0;
}

function getQuotaThresholds(env) {
  const info = Math.max(1, parseInt(env.QUOTA_WARN_INFO || DEFAULT_WARN_INFO, 10) || DEFAULT_WARN_INFO);
  const high = Math.max(info, parseInt(env.QUOTA_WARN_HIGH || DEFAULT_WARN_HIGH, 10) || DEFAULT_WARN_HIGH);
  const cap = Math.max(high, parseInt(env.QUOTA_HARD_CAP || DEFAULT_HARD_CAP, 10) || DEFAULT_HARD_CAP);
  return { info, high, cap };
}

function classifyTier(used, thresholds) {
  if (used >= thresholds.cap) return "blocked";
  if (used >= thresholds.high) return "warn";
  if (used >= thresholds.info) return "info";
  return "normal";
}

/**
 * Durable Object enforcing single-threaded atomic monthly quota reservation.
 * Wrangler binding example:
 *   [[durable_objects.bindings]]
 *   name = "QUOTA_LIMITER"
 *   class_name = "QuotaLimiter"
 */
export class QuotaLimiter {
  constructor(state, env) {
    this.state = state;
    this.env = env || {};
    this._queue = Promise.resolve();
  }

  async fetch(request) {
    // Serialize reservations strictly even in custom test harnesses without DO runtime mutex
    const run = async () => {
      const url = new URL(request.url);
      const ym = url.searchParams.get("ym") || new Date().toISOString().slice(0, 7);
      const info = Math.max(1, parseInt(url.searchParams.get("info") || DEFAULT_WARN_INFO, 10));
      const high = Math.max(info, parseInt(url.searchParams.get("high") || DEFAULT_WARN_HIGH, 10));
      const cap = Math.max(high, parseInt(url.searchParams.get("cap") || DEFAULT_HARD_CAP, 10));
      const storageKey = `gmaps_used_${ym}`;

      if (request.method === "GET") {
        const cur = Number((await this.state.storage.get(storageKey)) || 0);
        return jsonResp({ ok: true, ym, used: cur, cap, info, high, tier: classifyTier(cur, { info, high, cap }) }, 200);
      }

      if (request.method !== "POST") {
        return jsonResp({ ok: false, error: "Method not allowed" }, 405);
      }

      const cur = Number((await this.state.storage.get(storageKey)) || 0);
      if (!Number.isFinite(cur) || cur < 0) {
        return jsonResp({ ok: false, error: "Corrupted quota state" }, 500);
      }
      if (cur >= cap) {
        return jsonResp({
          ok: false,
          allowed: false,
          ym,
          used: cur,
          cap,
          info,
          high,
          tier: "blocked",
          error: `团队本月 Google Maps 检索配额已达硬上限 (${cur}/${cap})，已自动熔断拦截，零超额放行。`,
        }, 429);
      }

      const nextUsed = cur + 1;
      await this.state.storage.put(storageKey, nextUsed);
      const tier = nextUsed >= high ? "warn" : (nextUsed >= info ? "info" : "normal");
      return jsonResp({
        ok: true,
        allowed: true,
        ym,
        used: nextUsed,
        cap,
        info,
        high,
        tier,
      }, 200);
    };

    const next = this._queue.then(run, run);
    this._queue = next.catch(() => {});
    return next;
  }
}

export default {
  async fetch(request, env = {}) {
    const cors = buildCorsHeaders(request, env);
    const allowedList = parseAllowedOrigins(env);
    const reqOrigin = request.headers.get("Origin") || "";

    // 1. Strict Origin enforcement when ALLOWED_ORIGIN is configured
    if (allowedList.length > 0 && !allowedList.includes(reqOrigin)) {
      return jsonResp(
        { error: "非法来源域名请求已拦截 (Origin 403 Forbidden)" },
        403,
        cors
      );
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "POST") {
      return jsonResp({ error: "POST only" }, 405, cors);
    }

    // 2. Mandatory constant-time TEAM_PASS check
    if (!env.TEAM_PASS || !String(env.TEAM_PASS).trim()) {
      return jsonResp(
        { error: "服务端安全熔断：请先在 Cloudflare Worker Secrets 配置 TEAM_PASS 团队口令后再启用。" },
        503,
        cors
      );
    }
    const pass = request.headers.get("X-Team-Pass") || "";
    if (!timingSafeEqualStr(pass, env.TEAM_PASS)) {
      return jsonResp({ error: "团队访问口令不正确（请在页面填写正确口令）" }, 401, cors);
    }

    if (!env.GOOGLE_MAPS_API_KEY || !String(env.GOOGLE_MAPS_API_KEY).trim()) {
      return jsonResp({ error: "Worker 尚未配置 GOOGLE_MAPS_API_KEY 密钥" }, 500, cors);
    }

    // 3. Validate client payload BEFORE reserving atomic quota so bad input never wastes quota
    let body = {};
    try {
      body = await request.json();
    } catch {
      return jsonResp({ error: "Invalid JSON body" }, 400, cors);
    }

    const textQuery = String((body && body.textQuery) || "").trim();
    if (!textQuery || textQuery.length > 300) {
      return jsonResp({ error: "请提供有效的搜索关键词 textQuery（1–300 字符）" }, 400, cors);
    }

    // 4. Atomic Monthly Quota Pre-Reservation via Durable Object (Fail-Closed on missing/error)
    const thresholds = getQuotaThresholds(env);
    const ym = new Date().toISOString().slice(0, 7);
    let quotaMeta = {
      used: null,
      cap: thresholds.cap,
      info: thresholds.info,
      high: thresholds.high,
      tier: "unmetered_dev",
    };

    if (env.QUOTA_LIMITER && typeof env.QUOTA_LIMITER.idFromName === "function") {
      try {
        const doId = env.QUOTA_LIMITER.idFromName(`monthly_${ym}`);
        const stub = env.QUOTA_LIMITER.get(doId);
        const qUrl = `https://quota.internal/reserve?ym=${encodeURIComponent(ym)}&info=${thresholds.info}&high=${thresholds.high}&cap=${thresholds.cap}`;
        const qRes = await stub.fetch(new Request(qUrl, { method: "POST" }));
        const qData = await qRes.json();
        if (qRes.status === 429 || qData.allowed === false) {
          return jsonResp(
            {
              error: qData.error || `本月团队配额已达硬上限 (${thresholds.cap} 次)，已暂停调用。`,
              quotaUsed: qData.used ?? thresholds.cap,
              quotaCap: thresholds.cap,
              quotaWarnInfo: thresholds.info,
              quotaWarnHigh: thresholds.high,
              quotaTier: "blocked",
            },
            429,
            cors
          );
        }
        if (!qRes.ok || !qData.ok) {
          return jsonResp(
            { error: "配额状态服务异常，已执行安全熔断 (Fail-Closed)，未请求 Google 上游。" },
            503,
            cors
          );
        }
        quotaMeta = {
          used: qData.used,
          cap: qData.cap,
          info: qData.info,
          high: qData.high,
          tier: qData.tier,
        };
      } catch (err) {
        return jsonResp(
          { error: "配额原子锁异常，已执行安全熔断 (Fail-Closed 503)，未触发上游计费。" },
          503,
          cors
        );
      }
    } else if (String(env.ALLOW_UNMETERED_DEV || "") !== "true") {
      return jsonResp(
        {
          error: "服务端未绑定 QUOTA_LIMITER (Durable Object)，已默认阻断请求 (Fail-Closed 503) 以防无上限计费。",
        },
        503,
        cors
      );
    }

    // 5. Upstream Google Places API call (NEVER refund quota once initiated, as upstream may bill)
    const rawPageSize = parseInt(body.pageSize == null ? 20 : body.pageSize, 10);
    const payload = {
      textQuery,
      pageSize: Math.min(20, Math.max(5, Number.isFinite(rawPageSize) ? rawPageSize : 20)),
    };
    if (body.pageToken) payload.pageToken = String(body.pageToken).slice(0, 512);
    if (body.languageCode) payload.languageCode = String(body.languageCode).slice(0, 16);

    let gRes;
    try {
      gRes = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": env.GOOGLE_MAPS_API_KEY,
          "X-Goog-FieldMask": FIELD_MASK,
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      return jsonResp(
        {
          error: "连接 Google Maps 上游失败（本次预扣配额不予回退以防重复计费）：" + String(err),
          quotaUsed: quotaMeta.used,
          quotaCap: quotaMeta.cap,
          quotaWarnInfo: quotaMeta.info,
          quotaWarnHigh: quotaMeta.high,
          quotaTier: quotaMeta.tier,
        },
        502,
        cors
      );
    }

    let data = {};
    const rawText = await gRes.text();
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      return jsonResp(
        {
          error: `Google Maps 上游返回非 JSON 响应 (HTTP ${gRes.status})`,
          quotaUsed: quotaMeta.used,
          quotaCap: quotaMeta.cap,
          quotaWarnInfo: quotaMeta.info,
          quotaWarnHigh: quotaMeta.high,
          quotaTier: quotaMeta.tier,
        },
        502,
        cors
      );
    }

    let quotaNotice = "";
    if (quotaMeta.tier === "warn") {
      quotaNotice = `⚠️ 高水位预警：本月团队已用 ${quotaMeta.used}/${quotaMeta.cap} 次（≥${quotaMeta.high} 预警线），达 ${quotaMeta.cap} 次将硬熔断！`;
    } else if (quotaMeta.tier === "info") {
      quotaNotice = `ℹ️ 用量提醒：本月团队已用 ${quotaMeta.used}/${quotaMeta.cap} 次（≥${quotaMeta.info} 提醒线）。`;
    }

    return jsonResp(
      {
        places: data.places || [],
        nextPageToken: data.nextPageToken || "",
        error: data.error ? data.error.message : "",
        quotaUsed: quotaMeta.used,
        quotaCap: quotaMeta.cap,
        quotaWarnInfo: quotaMeta.info,
        quotaWarnHigh: quotaMeta.high,
        quotaTier: quotaMeta.tier,
        quotaNotice,
      },
      gRes.ok ? 200 : gRes.status,
      cors
    );
  },
};

function jsonResp(obj, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}
