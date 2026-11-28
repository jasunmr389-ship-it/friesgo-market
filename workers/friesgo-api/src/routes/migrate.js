// Lossless Idempotent IndexedDB -> Cloudflare D1 Historical Migration API (Dry-Run + Commit)
// Preserves stable IDs (id / tlId / quoteId / logId), never downgrades opt-out or compliance blocks,
// and never creates duplicate rows on repeated migration submissions.

import { requireLegacyMainInternal } from "../auth.js";
import { randomId } from "../crypto.js";
import {
  extractCleanDomain,
  isPublicOrPlatformDomain,
  json,
  monotonicCompliance,
  monotonicOptOut,
  normalizeCompanyName,
  normalizePhoneDigits,
  nowIso,
  parseJsonBody,
  writeAuditLog,
} from "../utils.js";
import { batchDedupeCandidates, recomputeCompanyDerivedState } from "./companies.js";

function mapLegacyChannel(ch) {
  const s = String(ch || "").toLowerCase();
  if (/mail|邮件/.test(s)) return "email";
  if (/whatsapp|wa/.test(s)) return "whatsapp";
  if (/phone|call|电话/.test(s)) return "phone";
  if (/linkedin|领英|社媒/.test(s)) return "linkedin";
  if (/meet|会议|拜访/.test(s)) return "meeting";
  if (/quote|报价/.test(s)) return "quote";
  if (/dd|背调/.test(s)) return "dd";
  return "other";
}

function mapLegacyOutcome(stage, text) {
  const hay = `${stage || ""} ${text || ""}`.toLowerCase();
  if (/退订|unsubscrib/.test(hay)) return "unsubscribed";
  if (/拒绝|拉黑|reject|do not contact/.test(hay)) return "rejected";
  if (/已报价|发报价|quote/.test(hay)) return "quote_sent";
  if (/询盘|inquir/.test(hay)) return "inquiry";
  if (/回复|跟进|repli/.test(hay)) return "replied";
  if (/未接通|no answer/.test(hay)) return "no_answer";
  if (/秒挂|挂断|hung/.test(hay)) return "hung_up";
  if (/已发|联系|sent/.test(hay)) return "sent";
  return "note";
}

function mapLegacyCompliance(dd) {
  if (!dd || typeof dd !== "object") return "unchecked";
  const v = String(dd.verdict || "").toLowerCase();
  if (v === "block" || v === "blocked") return "blocked";
  if (v === "pass" || v === "approved") return "approved";
  if (v === "review" || v === "warn") return "review";
  return "unchecked";
}

function mapLegacyOptOut(lead) {
  const stg = String((lead && lead.stage) || "").toLowerCase();
  const note = String((lead && lead.note) || "").toLowerCase();
  if (lead && lead.optOut) return "all_blocked";
  if (/退订|unsubscrib|do not contact/.test(stg + " " + note)) return "all_blocked";
  if (/明确拒绝|停止联系/.test(stg + " " + note)) return "marketing_blocked";
  return "none";
}

export async function handleMigrateRoutes(request, env, cors, url) {
  const path = url.pathname;
  const method = request.method;

  // 1. Dry-Run Scan: inspect uploaded IndexedDB leads against D1 without writing a single row
  if (path === "/api/migrate/dry-run" && method === "POST") {
    const auth = await requireLegacyMainInternal(request, env, cors);
    if (!auth.ok) return auth.response;
    const body = await parseJsonBody(request, 2 * 1024 * 1024);
    const leads = (Array.isArray(body.leads) ? body.leads : []).filter((l) => l && !l.deletedAt && (l.company || l.canonical_name));
    const complianceLogs = Array.isArray(body.complianceLogs) ? body.complianceLogs : [];

    // Check by stable ID first, then batch dedupe in chunks of 100
    const existingById = new Set();
    const idList = leads.map((l) => String(l.id || "").trim()).filter(Boolean);
    for (let i = 0; i < idList.length; i += 80) {
      const chunk = idList.slice(i, i + 80);
      const ph = chunk.map(() => "?").join(",");
      const res = auth.v4
        ? await env.DB.prepare(`SELECT id FROM companies WHERE org_id = ? AND id IN (${ph})`).bind(auth.orgId, ...chunk).all()
        : await env.DB.prepare(`SELECT id FROM companies WHERE id IN (${ph})`).bind(...chunk).all();
      for (const r of res.results || []) existingById.add(r.id);
    }

    const dedupeAll = [];
    for (let i = 0; i < leads.length; i += 100) {
      const slice = leads.slice(i, i + 100);
      const res = await batchDedupeCandidates(env.DB, slice, auth.v4 ? auth.orgId : null);
      res.forEach((r, j) => dedupeAll.push({ ...r, index: i + j }));
    }

    let createCount = 0;
    let mergeHighCount = 0;
    let suspectReviewCount = 0;
    let timelineTotal = 0;
    let quoteTotal = 0;
    let gmapsLegacyFlagged = 0;

    const preview = leads.map((l, idx) => {
      const stableId = String(l.id || "").trim();
      const d = dedupeAll[idx] || { status: "new", reason: "" };
      const tlCnt = Array.isArray(l.timeline) ? l.timeline.length : 0;
      const qtCnt = Array.isArray(l.quotes) ? l.quotes.length : 0;
      timelineTotal += tlCnt;
      quoteTotal += qtCnt;
      const isLegacyGmaps = /google\s*maps/i.test(String(l.source || ""));
      if (isLegacyGmaps) gmapsLegacyFlagged++;

      let action = "create";
      let targetId = stableId;
      let reason = d.reason;
      if (stableId && existingById.has(stableId)) {
        action = "merge_high";
        targetId = stableId;
        reason = "已存在相同稳定企业 ID（将按幂等规则合并补全历史）";
        mergeHighCount++;
      } else if (d.status === "high_match" && d.match) {
        action = "merge_high";
        targetId = d.match.id;
        mergeHighCount++;
      } else if (d.status === "suspect_duplicate") {
        action = "suspect_review";
        suspectReviewCount++;
      } else {
        createCount++;
      }

      return {
        index: idx,
        localId: stableId,
        company: l.company || l.canonical_name,
        country: l.country || l.country_en || "",
        action,
        targetId: action === "merge_high" ? targetId : "",
        reason,
        candidates: d.candidates || [],
        timelineCount: tlCnt,
        quoteCount: qtCnt,
        isLegacyGmaps,
      };
    });

    return json(
      {
        ok: true,
        dryRun: true,
        summary: {
          totalLeads: leads.length,
          createCount,
          mergeHighCount,
          suspectReviewCount,
          timelineTotal,
          quoteTotal,
          complianceLogTotal: complianceLogs.length,
          gmapsLegacyFlagged,
        },
        preview,
      },
      200,
      cors
    );
  }

  // 2. Idempotent Commit: writes companies, contacts, timeline events, quotes & order compliance logs
  if (path === "/api/migrate/commit" && method === "POST") {
    const auth = await requireLegacyMainInternal(request, env, cors);
    if (!auth.ok) return auth.response;
    const body = await parseJsonBody(request, 2 * 1024 * 1024);

    const batchId = String(body.batch_id || "").trim() || randomId("mig");
    const leads = (Array.isArray(body.leads) ? body.leads : []).filter((l) => l && !l.deletedAt && (l.company || l.canonical_name));
    const complianceLogs = Array.isArray(body.complianceLogs) ? body.complianceLogs : [];
    // Optional per-lead human decisions for suspect duplicates: { [localId]: { action: 'merge' | 'create_new' | 'skip', targetId } }
    const decisions = body.decisions && typeof body.decisions === "object" ? body.decisions : {};

    const now = nowIso();
    const idMap = new Map(); // maps local lead.id -> authoritative D1 company_id
    let companiesCreated = 0;
    let companiesMerged = 0;
    let companiesSkipped = 0;
    let contactsInserted = 0;
    let eventsInserted = 0;
    let quotesUpserted = 0;
    let complianceLogsUpserted = 0;

    // Run dedupe in batches
    const dedupeAll = [];
    for (let i = 0; i < leads.length; i += 100) {
      const slice = leads.slice(i, i + 100);
      const res = await batchDedupeCandidates(env.DB, slice, auth.v4 ? auth.orgId : null);
      res.forEach((r, j) => dedupeAll.push({ ...r, index: i + j }));
    }

    for (let i = 0; i < leads.length; i++) {
      const l = leads[i];
      const localId = String(l.id || "").trim() || randomId("cmp");
      const name = String(l.company || l.canonical_name || "").trim();
      const country = String(l.country || l.country_en || "Vietnam").trim();
      const city = String(l.city || "").trim();
      const website = String(l.website || "").trim();
      const domRaw = extractCleanDomain(website || l.email || "");
      const corpDom = isPublicOrPlatformDomain(domRaw) ? "" : domRaw;
      const compStatus = mapLegacyCompliance(l.dd);
      const optOut = mapLegacyOptOut(l);
      const dec = decisions[localId] || decisions[String(i)] || null;
      const d = dedupeAll[i] || { status: "new" };

      if (dec && dec.action === "skip") {
        companiesSkipped++;
        continue;
      }

      // Determine authoritative target company ID (strictly main-org scoped in V4)
      let targetId = "";
      const existingSameId = auth.v4
        ? await env.DB.prepare("SELECT * FROM companies WHERE id = ? AND org_id = ?").bind(localId, auth.orgId).first()
        : await env.DB.prepare("SELECT * FROM companies WHERE id = ?").bind(localId).first();
      if (existingSameId) {
        targetId = existingSameId.id;
      } else if (dec && dec.action === "merge" && dec.targetId) {
        const tgtRow = auth.v4
          ? await env.DB.prepare("SELECT id FROM companies WHERE id = ? AND org_id = ? AND deleted_at IS NULL").bind(dec.targetId, auth.orgId).first()
          : await env.DB.prepare("SELECT id FROM companies WHERE id = ? AND deleted_at IS NULL").bind(dec.targetId).first();
        if (tgtRow) targetId = tgtRow.id;
      } else if ((!dec || dec.action !== "create_new") && d.status === "high_match" && d.match && d.match.id) {
        targetId = d.match.id;
      }

      if (targetId) {
        const cur = await env.DB.prepare("SELECT * FROM companies WHERE id = ?").bind(targetId).first();
        const mergedOptOut = monotonicOptOut(cur.opt_out_status, optOut);
        const mergedComp = monotonicCompliance(cur.compliance_status, compStatus, false);
        const mergedNote = cur.note || String(l.note || "");
        const mergedProd = cur.product_summary || String(l.product || "");
        const mergedNextDate = cur.next_follow_date || String(l.nextDate || "");
        await env.DB
          .prepare(
            `UPDATE companies
             SET opt_out_status = ?, compliance_status = ?, product_summary = ?, note = ?, next_follow_date = ?,
                 website = CASE WHEN website = '' THEN ? ELSE website END,
                 website_domain = CASE WHEN website_domain = '' THEN ? ELSE website_domain END,
                 updated_by = ?, updated_at = ?
             WHERE id = ?`
          )
          .bind(mergedOptOut, mergedComp, mergedProd, mergedNote, mergedNextDate, website, corpDom, auth.actor.id, now, targetId)
          .run();
        companiesMerged++;
      } else {
        targetId = localId;
        await env.DB
          .prepare(
            `INSERT INTO companies (
               id, canonical_name, norm_name, aliases_json, country_en, city, address, website, website_domain,
               industry_type, buyer_type, product_summary, pool_stage, compliance_status, dd_json, opt_out_status,
               opt_out_meta_json, stage, next_follow_date, cadence_step, cadence_label, note, last_event_summary_json,
               derived_contact_status, version, created_by, updated_by, schema_version, created_at, updated_at
             ) VALUES (?, ?, ?, '[]', ?, ?, '', ?, ?, '', '', ?, 'active', ?, ?, ?, '{}', ?, ?, ?, ?, ?, '{}', 'uncontacted', 1, ?, ?, 1, ?, ?)`
          )
          .bind(
            targetId,
            name,
            normalizeCompanyName(name),
            country,
            city,
            website,
            corpDom,
            String(l.product || ""),
            compStatus,
            JSON.stringify(l.dd && typeof l.dd === "object" ? l.dd : {}),
            optOut,
            String(l.stage || "待开发"),
            String(l.nextDate || ""),
            parseInt(l.cadenceStep || 0, 10) || 0,
            String(l.cadenceLabel || ""),
            String(l.note || ""),
            auth.actor.id,
            auth.actor.id,
            now,
            now
          )
          .run();

        await env.DB
          .prepare(
            `INSERT OR IGNORE INTO source_evidences (id, company_id, field_scope, source_type, source_url, license_class, verified_by, verified_at, schema_version, created_at)
             VALUES (?, ?, 'company', 'migration', ?, 'independent', ?, ?, 1, ?)`
          )
          .bind(`src_mig_${targetId}`, targetId, String(l.source || "IndexedDB 历史迁移").slice(0, 200), auth.actor.id, now, now)
          .run();
        companiesCreated++;
      }

      idMap.set(localId, targetId);

      // Contacts (main + contacts[] array, idempotent by deterministic ctId)
      const contactCandidates = [];
      if (l.email || l.phone || l.contact) {
        contactCandidates.push({
          id: `ct_main_${targetId}`,
          name: String(l.contact || ""),
          role: "",
          email: String(l.email || "").trim().toLowerCase(),
          phone: normalizePhoneDigits(l.phone || ""),
        });
      }
      if (Array.isArray(l.contacts)) {
        l.contacts.forEach((ct, ci) => {
          if (!ct) return;
          contactCandidates.push({
            id: String(ct.id || `ct_${targetId}_${ci}`),
            name: String(ct.name || ""),
            role: String(ct.role || ""),
            email: String(ct.email || "").trim().toLowerCase(),
            phone: normalizePhoneDigits(ct.phone || ""),
          });
        });
      }
      for (const ct of contactCandidates) {
        if (!ct.name && !ct.email && !ct.phone) continue;
        const cIns = await env.DB
          .prepare(
            `INSERT OR IGNORE INTO company_contacts (id, company_id, name, role, email, email_verify_level, phone_e164, whatsapp_ok, source_type, verified_at, opt_out_flag, schema_version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'guessed', ?, 0, 'migration', ?, 0, 1, ?, ?)`
          )
          .bind(ct.id, targetId, ct.name, ct.role, ct.email, ct.phone, now, now, now)
          .run();
        if (cIns && cIns.meta && cIns.meta.changes > 0) contactsInserted++;
      }

      // Append-only Timeline Events (strictly idempotent by stable tlId!)
      if (Array.isArray(l.timeline)) {
        for (let ti = 0; ti < l.timeline.length; ti++) {
          const tl = l.timeline[ti];
          if (!tl) continue;
          const evId = String(tl.tlId || tl.id || `tl_mig_${localId}_${ti}`).trim();
          const ch = mapLegacyChannel(tl.channel);
          const out = mapLegacyOutcome(l.stage, `${tl.result || ""} ${tl.nextAction || ""}`);
          const occ = String(tl.ts || tl.date || now);
          const eIns = await env.DB
            .prepare(
              `INSERT OR IGNORE INTO contact_events (event_id, company_id, contact_id, employee_id, employee_name, channel, action_outcome, summary, next_action, next_follow_date, occurred_at, schema_version, created_at)
               VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
            )
            .bind(
              evId,
              targetId,
              auth.actor.id,
              String(tl.owner || l.owner || auth.actor.display_name),
              ch,
              out,
              String(tl.result || "").slice(0, 600),
              String(tl.nextAction || "").slice(0, 200),
              String(tl.nextDate || ""),
              occ,
              now
            )
            .run();
          if (eIns && eIns.meta && eIns.meta.changes > 0) eventsInserted++;
        }
      }

      // Quotes (strictly idempotent by stable quoteId!)
      if (Array.isArray(l.quotes)) {
        for (let qi = 0; qi < l.quotes.length; qi++) {
          const q = l.quotes[qi];
          if (!q) continue;
          const qId = String(q.quoteId || q.id || `qt_mig_${localId}_${qi}`).trim();
          await env.DB
            .prepare(
              `INSERT OR IGNORE INTO quote_records (quote_id, company_id, ref_no, quote_tier, profile_version, payload_json, sent_confirmed, created_by, schema_version, created_at, updated_at)
               VALUES (?, ?, ?, ?, 1, ?, 0, ?, 1, ?, ?)`
            )
            .bind(
              qId,
              targetId,
              String(q.refNo || q.ver || ""),
              q.quoteTier === "formal" ? "formal" : "indicative",
              JSON.stringify(q),
              auth.actor.id,
              String(q.ts || now),
              now
            )
            .run();
          quotesUpserted++;
        }
      }

      await recomputeCompanyDerivedState(env.DB, targetId);
    }

    // Order-level Pre-Shipment Compliance Logs (strictly idempotent by stable logId!)
    for (let li = 0; li < complianceLogs.length; li++) {
      const log = complianceLogs[li];
      if (!log) continue;
      const logId = String(log.logId || log.id || `pcl_mig_${li}`).trim();
      const mappedCompId = idMap.get(String(log.clientId || "")) || String(log.clientId || "");
      await env.DB
        .prepare(
          `INSERT OR IGNORE INTO compliance_order_logs (log_id, order_ref, company_id, decision, checks_json, reviewer, saved_at, schema_version, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
        )
        .bind(
          logId,
          String(log.orderRef || ""),
          mappedCompId,
          String(log.decision || "review"),
          JSON.stringify(log.checks || {}),
          String(log.reviewer || auth.actor.display_name),
          String(log.savedAt || now),
          now
        )
        .run();
      complianceLogsUpserted++;
    }

    const report = {
      batchId,
      companiesCreated,
      companiesMerged,
      companiesSkipped,
      contactsInserted,
      eventsInserted,
      quotesUpserted,
      complianceLogsUpserted,
    };

    await env.DB
      .prepare(
        `INSERT OR REPLACE INTO migration_batches (batch_id, employee_id, employee_name, summary_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(batchId, auth.actor.id, auth.actor.display_name, JSON.stringify(report), now)
      .run();
    await writeAuditLog(env.DB, auth.actor, "MIGRATE_INDEXEDDB_BATCH", "migration", batchId, JSON.stringify(report));

    return json({ ok: true, report }, 200, cors);
  }

  return null;
}
