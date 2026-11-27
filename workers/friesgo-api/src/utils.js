// Shared HTTP, CORS, normalization, status derivation, PII redaction, and audit helpers

import { randomId } from "./crypto.js";

export function nowIso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

export function addSecondsIso(seconds, baseMs = Date.now()) {
  return new Date(baseMs + seconds * 1000).toISOString();
}

export function addDaysIso(days, baseMs = Date.now()) {
  return new Date(baseMs + days * 86400 * 1000).toISOString();
}

export function parseAllowedOrigins(env) {
  return String((env && env.ALLOWED_ORIGINS) || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isOriginAllowed(reqOrigin, env) {
  if (!reqOrigin) return true; // Non-browser server/CLI clients carry no Origin; Bearer auth still enforced
  const list = parseAllowedOrigins(env);
  if (!list.length) return false;
  for (const allowed of list) {
    if (reqOrigin === allowed) return true;
    // Allow explicit localhost / 127.0.0.1 with ephemeral test ports ONLY when listed in ALLOWED_ORIGINS (staging/dev)
    if (
      (allowed === "http://127.0.0.1" && /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(reqOrigin)) ||
      (allowed === "http://localhost" && /^http:\/\/localhost(:\d+)?$/.test(reqOrigin))
    ) {
      return true;
    }
  }
  return false;
}

export function buildCorsHeaders(request, env) {
  const reqOrigin = request.headers.get("Origin") || "";
  const ok = reqOrigin && isOriginAllowed(reqOrigin, env);
  return {
    "Access-Control-Allow-Origin": ok ? reqOrigin : "null",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Bootstrap-Secret",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  };
}

export function json(obj, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function parseJsonBody(request, maxBytes = 1024 * 1024) {
  const text = await request.text();
  if (text.length > maxBytes) {
    throw Object.assign(new Error("请求体过大"), { status: 413 });
  }
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      throw Object.assign(new Error("JSON 顶层须为对象"), { status: 400 });
    }
    return parsed;
  } catch (err) {
    if (err && err.status) throw err;
    throw Object.assign(new Error("JSON 请求格式非法"), { status: 400 });
  }
}

export function safeJsonParse(raw, fallback) {
  if (!raw || typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

const PUBLIC_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com", "icloud.com",
  "qq.com", "163.com", "126.com", "aol.com", "proton.me", "protonmail.com",
  "yandex.ru", "mail.ru", "linkedin.com", "facebook.com", "instagram.com",
  "alibaba.com", "made-in-china.com", "google.com", "whatsapp.com",
]);

export function extractCleanDomain(raw) {
  let s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  if (s.includes("@")) s = s.split("@").pop().split(/\s/)[0];
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].split("?")[0].split("#")[0].split(":")[0];
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) return "";
  return s;
}

export function isPublicOrPlatformDomain(domain) {
  const d = extractCleanDomain(domain);
  return !d || PUBLIC_DOMAINS.has(d);
}

const LEGAL_SUFFIX_RE = /\b(co|company|corp|corporation|ltd|limited|llc|inc|incorporated|sa|s\.a\.|s\.a\.s\.|s\.r\.l\.|srl|gmbh|ag|bv|b\.v\.|nv|jsc|pt|cv|sdn|bhd|pvt|pte|plc|oy|ab|as|sp|z\.o\.o\.|kft|sro|ltda|eirl|fzco|fze|wll|trading|import|export|international|intl)\b/gi;

export function normalizeCompanyName(name) {
  let s = String(name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  s = s.replace(/[^a-z0-9\u4e00-\u9fff\s]/g, " ");
  s = s.replace(LEGAL_SUFFIX_RE, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

export function normalizePhoneDigits(phone) {
  return String(phone || "").replace(/[^\d]/g, "");
}

export function redactPii(str) {
  let s = String(str || "");
  if (!s) return "";
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[已脱敏邮箱]");
  s = s.replace(/https?:\/\/[^\s<>'"]+/gi, "[已脱敏链接]");
  s = s.replace(/(?:\+?\d[\d\s().-]{6,}\d)/g, "[已脱敏号码]");
  return s;
}

const OPT_OUT_RANK = { none: 0, marketing_blocked: 1, all_blocked: 2 };
const COMPLIANCE_RANK = { unchecked: 0, review: 1, approved: 2, blocked: 3 };

export function monotonicOptOut(currentStatus, nextStatus) {
  const cur = OPT_OUT_RANK[currentStatus] != null ? currentStatus : "none";
  const nxt = OPT_OUT_RANK[nextStatus] != null ? nextStatus : "none";
  return OPT_OUT_RANK[nxt] >= OPT_OUT_RANK[cur] ? nxt : cur;
}

export function monotonicCompliance(currentStatus, nextStatus, allowDowngradeFromBlocked = false) {
  const cur = COMPLIANCE_RANK[currentStatus] != null ? currentStatus : "unchecked";
  const nxt = COMPLIANCE_RANK[nextStatus] != null ? nextStatus : cur;
  if (cur === "blocked" && !allowDowngradeFromBlocked) return "blocked";
  return nxt;
}

/**
 * Deterministic derivation of the 7 team-visible contact states from authoritative records.
 */
export function deriveContactStatus({ optOutStatus, complianceStatus, activeLock, events }) {
  if (optOutStatus && optOutStatus !== "none") return "stopped";
  if (complianceStatus === "blocked") return "stopped";
  const evs = Array.isArray(events) ? events : [];
  if (evs.some((e) => e && (e.action_outcome === "rejected" || e.action_outcome === "unsubscribed"))) {
    return "stopped";
  }
  if (activeLock && activeLock.expires_at && activeLock.expires_at > nowIso()) {
    return "preparing";
  }
  if (!evs.length) return "uncontacted";
  if (evs.some((e) => e && e.action_outcome === "quote_sent")) return "quoted";
  if (evs.some((e) => e && e.action_outcome === "inquiry")) return "inquired";
  if (evs.some((e) => e && e.action_outcome === "replied")) return "following_up";
  if (evs.some((e) => e && (e.action_outcome === "sent" || e.action_outcome === "no_answer" || e.action_outcome === "hung_up"))) {
    return "contacted_no_reply";
  }
  return "uncontacted";
}

export async function writeAuditLog(db, actor, action, targetType, targetId, diffSummary = "") {
  const id = randomId("aud");
  const actorId = (actor && actor.id) || "system";
  const actorName = (actor && actor.display_name) || actorId;
  const summary = String(diffSummary || "").slice(0, 600);
  await db
    .prepare(
      "INSERT INTO audit_logs (id, actor_id, actor_name, action, target_type, target_id, diff_summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(id, actorId, actorName, String(action), String(targetType), String(targetId), summary, nowIso())
    .run();
  return id;
}

export function getClientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    (request.headers.get("X-Forwarded-For") || "").split(",")[0].trim() ||
    "0.0.0.0"
  );
}
