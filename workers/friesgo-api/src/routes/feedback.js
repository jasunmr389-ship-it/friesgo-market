// Authenticated Team Co-Creation Feedback Board (D1 feedback_items)
// External/unauthenticated visitors are strictly rejected with 401 (no anonymous DB spam).

import { requireAuth } from "../auth.js";
import { randomId } from "../crypto.js";
import { json, nowIso, parseJsonBody, redactPii, safeJsonParse, writeAuditLog } from "../utils.js";

const VALID_STATUS = new Set(["open", "planned", "shipped", "declined"]);

export async function handleFeedbackRoutes(request, env, cors, url) {
  const path = url.pathname;
  const method = request.method;

  // 1. List team co-creation feedback board (authenticated employees only)
  if (path === "/api/feedback" && method === "GET") {
    const auth = await requireAuth(request, env, cors);
    if (!auth.ok) return auth.response;
    const status = String(url.searchParams.get("status") || "all").trim();
    const sql =
      status && status !== "all" && VALID_STATUS.has(status)
        ? "SELECT * FROM feedback_items WHERE status = ? ORDER BY created_at DESC LIMIT 60"
        : "SELECT * FROM feedback_items ORDER BY created_at DESC LIMIT 60";
    const rows =
      status && status !== "all" && VALID_STATUS.has(status)
        ? await env.DB.prepare(sql).bind(status).all()
        : await env.DB.prepare(sql).all();
    const items = (rows.results || []).map((r) => ({
      ...r,
      sanitized_context: safeJsonParse(r.sanitized_context_json, {}),
    }));
    return json({ ok: true, items }, 200, cors);
  }

  // 2. Submit PII-scrubbed feedback item to company D1 board (authenticated employees only)
  if (path === "/api/feedback" && method === "POST") {
    const auth = await requireAuth(request, env, cors);
    if (!auth.ok) return auth.response;
    const body = await parseJsonBody(request, 16384);

    const rawContent = String(body.content || body.message || "").trim();
    if (!rawContent) return json({ error: "请填写反馈或建议内容" }, 400, cors);

    // Server-side PII scrubbing defense-in-depth
    const safeContent = redactPii(rawContent).slice(0, 600);
    const category = String(body.category || "新功能建议").trim().slice(0, 32);
    const ctxIn = body.context && typeof body.context === "object" ? body.context : {};
    const safeCtx = {
      activeTool: String(ctxIn.activeTool || "").slice(0, 60),
      activeCountry: String(ctxIn.activeCountry || "").slice(0, 40),
      prodProfile: String(ctxIn.prodProfile || "").slice(0, 40),
      viewport: String(ctxIn.viewport || "").slice(0, 24),
      envTag: String(ctxIn.envTag || "").slice(0, 32),
      appVersion: String(ctxIn.appVersion || "v2.1-m2a").slice(0, 24),
      lastError: redactPii(String(ctxIn.lastError || "")).slice(0, 140),
    };

    const id = randomId("fb");
    const now = nowIso();
    await env.DB
      .prepare(
        `INSERT INTO feedback_items (id, employee_id, employee_name, category, content, sanitized_context_json, status, admin_reply, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', '', ?, ?)`
      )
      .bind(id, auth.actor.id, auth.actor.display_name, category, safeContent, JSON.stringify(safeCtx), now, now)
      .run();

    const created = await env.DB.prepare("SELECT * FROM feedback_items WHERE id = ?").bind(id).first();
    return json({ ok: true, item: { ...created, sanitized_context: safeCtx } }, 201, cors);
  }

  // 3. Admin / Manager triage & reply on feedback item
  const fbMatch = path.match(/^\/api\/feedback\/([^/]+)$/);
  if (fbMatch && method === "PATCH") {
    const auth = await requireAuth(request, env, cors, { roles: ["super_admin", "manager"] });
    if (!auth.ok) return auth.response;
    const id = decodeURIComponent(fbMatch[1]);
    const body = await parseJsonBody(request, 8192);
    const cur = await env.DB.prepare("SELECT * FROM feedback_items WHERE id = ?").bind(id).first();
    if (!cur) return json({ error: "反馈记录不存在" }, 404, cors);

    const nextStatus = VALID_STATUS.has(body.status) ? body.status : cur.status;
    const nextReply = typeof body.admin_reply === "string" ? body.admin_reply.trim().slice(0, 400) : cur.admin_reply;
    const now = nowIso();
    await env.DB
      .prepare("UPDATE feedback_items SET status = ?, admin_reply = ?, updated_at = ? WHERE id = ?")
      .bind(nextStatus, nextReply, now, id)
      .run();
    await writeAuditLog(env.DB, auth.actor, "UPDATE_FEEDBACK", "feedback", id, `status:${cur.status}->${nextStatus}`);
    const updated = await env.DB.prepare("SELECT * FROM feedback_items WHERE id = ?").bind(id).first();
    return json({ ok: true, item: updated }, 200, cors);
  }

  return null;
}
