// Unified Enterprise Master Pool, Batch Dedupe, Lossless Reversible Merge,
// Physically Isolated OSM Raw Pool (ODbL), Quotes/Compliance Ledger, and Metadata Search Logs

import { requireAuth } from "../auth.js";
import { randomId } from "../crypto.js";
import {
  deriveContactStatus,
  extractCleanDomain,
  isPublicOrPlatformDomain,
  json,
  monotonicCompliance,
  monotonicOptOut,
  normalizeCompanyName,
  normalizePhoneDigits,
  nowIso,
  parseJsonBody,
  safeJsonParse,
  writeAuditLog,
} from "../utils.js";

export async function recomputeCompanyDerivedState(db, companyId) {
  const comp = await db.prepare("SELECT * FROM companies WHERE id = ?").bind(companyId).first();
  if (!comp) return null;
  const now = nowIso();
  const evRankRow = await db
    .prepare(
      `SELECT MAX(CASE WHEN action_outcome = 'unsubscribed' THEN 2 WHEN action_outcome = 'rejected' THEN 1 ELSE 0 END) AS max_opt_rank
       FROM contact_events WHERE company_id = ?`
    )
    .bind(companyId)
    .first();
  const maxEvRank = Number((evRankRow && evRankRow.max_opt_rank) || 0);
  const evImpliedOptOut = maxEvRank >= 2 ? "all_blocked" : maxEvRank === 1 ? "marketing_blocked" : "none";
  const authoritativeOptOut = monotonicOptOut(comp.opt_out_status, evImpliedOptOut);

  if (authoritativeOptOut !== "none") {
    await db.prepare("DELETE FROM contact_locks WHERE company_id = ?").bind(companyId).run();
  }

  const activeLock =
    authoritativeOptOut === "none"
      ? await db
          .prepare("SELECT * FROM contact_locks WHERE company_id = ? AND expires_at > ?")
          .bind(companyId, now)
          .first()
      : null;
  const evRows = await db
    .prepare(
      "SELECT event_id, employee_id, employee_name, channel, action_outcome, summary, next_action, next_follow_date, occurred_at FROM contact_events WHERE company_id = ? ORDER BY occurred_at DESC LIMIT 50"
    )
    .bind(companyId)
    .all();
  const events = evRows.results || [];
  const derived = deriveContactStatus({
    optOutStatus: authoritativeOptOut,
    complianceStatus: comp.compliance_status,
    activeLock,
    events,
  });
  const lastSummary = events[0]
    ? {
        event_id: events[0].event_id,
        employee_id: events[0].employee_id,
        employee_name: events[0].employee_name,
        channel: events[0].channel,
        action_outcome: events[0].action_outcome,
        summary: events[0].summary,
        occurred_at: events[0].occurred_at,
      }
    : {};
  await db
    .prepare(
      `UPDATE companies
       SET opt_out_status = CASE
             WHEN ? = 'all_blocked' OR opt_out_status = 'all_blocked' THEN 'all_blocked'
             WHEN ? = 'marketing_blocked' OR opt_out_status = 'marketing_blocked' THEN 'marketing_blocked'
             ELSE opt_out_status
           END,
           derived_contact_status = ?,
           last_event_summary_json = ?,
           updated_at = ?
       WHERE id = ?`
    )
    .bind(authoritativeOptOut, authoritativeOptOut, derived, JSON.stringify(lastSummary), now, companyId)
    .run();
  return { derived, optOutStatus: authoritativeOptOut, lastSummary, activeLock, events };
}

/**
 * Classify a batch of candidate leads against the authoritative `companies` table.
 * High-confidence match:
 *   1. Exact google_place_id
 *   2. Exact non-public corporate website_domain (ONLY if same country OR exact name match; cross-country/different name on shared domain -> suspect_duplicate to protect group subsidiaries!)
 *   3. Exact normalized company name + same country + same city (when city present)
 * Suspect duplicate (ALWAYS requires human review — NEVER auto-merge):
 *   - Same shared corporate domain with different company name or different country (subsidiaries/branches)
 *   - Same normalized company name in same country with different/missing city
 *   - Same email or phone matching an existing company contact
 */
export async function batchDedupeCandidates(db, rawCandidates) {
  const candidates = (Array.isArray(rawCandidates) ? rawCandidates : []).slice(0, 100);
  if (!candidates.length) return [];

  const placeIds = new Set();
  const domains = new Set();
  const normNames = new Set();
  const emails = new Set();
  const phones = new Set();

  const prepared = candidates.map((c, idx) => {
    const name = String((c && (c.company || c.canonical_name || c.name)) || "").trim();
    const normName = normalizeCompanyName(name);
    const country = String((c && (c.country_en || c.country)) || "").trim();
    const city = String((c && c.city) || "").trim();
    const dom = extractCleanDomain((c && (c.website_domain || c.website || c.domain || c.email)) || "");
    const corpDom = isPublicOrPlatformDomain(dom) ? "" : dom;
    const placeId = String((c && (c.google_place_id || c.placeId)) || "").trim();
    const email = String((c && c.email) || "").trim().toLowerCase();
    const phoneDigits = normalizePhoneDigits((c && (c.phone_e164 || c.phone)) || "");

    if (placeId) placeIds.add(placeId);
    if (corpDom) domains.add(corpDom);
    if (normName) normNames.add(normName);
    if (email) emails.add(email);
    if (phoneDigits.length >= 7) phones.add(phoneDigits);

    return { idx, raw: c, name, normName, country, city, corpDom, placeId, email, phoneDigits };
  });

  const byId = new Map();
  const addComp = (row) => {
    if (row && row.id && !row.deleted_at && !row.merged_into_id) byId.set(row.id, row);
  };

  async function queryIn(sqlPrefix, values) {
    const arr = Array.from(values);
    if (!arr.length) return [];
    const ph = arr.map(() => "?").join(",");
    const res = await db.prepare(`${sqlPrefix} (${ph})`).bind(...arr).all();
    return res.results || [];
  }

  if (placeIds.size) {
    (
      await queryIn(
        "SELECT * FROM companies WHERE deleted_at IS NULL AND merged_into_id IS NULL AND google_place_id IN",
        placeIds
      )
    ).forEach(addComp);
  }
  if (domains.size) {
    (
      await queryIn(
        "SELECT * FROM companies WHERE deleted_at IS NULL AND merged_into_id IS NULL AND website_domain IN",
        domains
      )
    ).forEach(addComp);
  }
  if (normNames.size) {
    (
      await queryIn(
        "SELECT * FROM companies WHERE deleted_at IS NULL AND merged_into_id IS NULL AND norm_name IN",
        normNames
      )
    ).forEach(addComp);
  }

  const contactByEmail = new Map();
  const contactByPhone = new Map();
  if (emails.size) {
    const cRows = await queryIn(
      "SELECT company_id, email, phone_e164 FROM company_contacts WHERE deleted_at IS NULL AND lower(email) IN",
      emails
    );
    const extraCompIds = new Set();
    for (const cr of cRows) {
      if (cr.email) contactByEmail.set(cr.email.toLowerCase(), cr.company_id);
      if (!byId.has(cr.company_id)) extraCompIds.add(cr.company_id);
    }
    if (extraCompIds.size) {
      (
        await queryIn(
          "SELECT * FROM companies WHERE deleted_at IS NULL AND merged_into_id IS NULL AND id IN",
          extraCompIds
        )
      ).forEach(addComp);
    }
  }
  if (phones.size) {
    const cRows = await queryIn(
      "SELECT company_id, phone_e164 FROM company_contacts WHERE deleted_at IS NULL AND phone_e164 IN",
      phones
    );
    const extraCompIds = new Set();
    for (const cr of cRows) {
      if (cr.phone_e164) contactByPhone.set(cr.phone_e164, cr.company_id);
      if (!byId.has(cr.company_id)) extraCompIds.add(cr.company_id);
    }
    if (extraCompIds.size) {
      (
        await queryIn(
          "SELECT * FROM companies WHERE deleted_at IS NULL AND merged_into_id IS NULL AND id IN",
          extraCompIds
        )
      ).forEach(addComp);
    }
  }

  // Fetch active locks for matched companies in one batch query
  const lockMap = new Map();
  const matchedIds = Array.from(byId.keys());
  if (matchedIds.length) {
    const now = nowIso();
    const ph = matchedIds.map(() => "?").join(",");
    const lockRes = await db
      .prepare(`SELECT * FROM contact_locks WHERE expires_at > ? AND company_id IN (${ph})`)
      .bind(now, ...matchedIds)
      .all();
    for (const lk of lockRes.results || []) {
      lockMap.set(lk.company_id, lk);
    }
  }

  const allMatched = Array.from(byId.values());

  function summarizeMatch(row) {
    const lk = lockMap.get(row.id) || null;
    const status =
      row.opt_out_status !== "none" || row.compliance_status === "blocked"
        ? "stopped"
        : lk
          ? "preparing"
          : row.derived_contact_status || "uncontacted";
    return {
      id: row.id,
      canonical_name: row.canonical_name,
      country_en: row.country_en,
      city: row.city,
      website_domain: row.website_domain,
      pool_stage: row.pool_stage,
      derived_contact_status: status,
      opt_out_status: row.opt_out_status,
      compliance_status: row.compliance_status,
      last_event_summary: safeJsonParse(row.last_event_summary_json, {}),
      active_lock: lk
        ? { employee_name: lk.employee_name, channel: lk.channel, expires_at: lk.expires_at }
        : null,
    };
  }

  return prepared.map((p) => {
    let highMatch = null;
    let highReason = "";
    const suspects = [];

    for (const c of allMatched) {
      // 1. Exact Google Place ID
      if (p.placeId && c.google_place_id && c.google_place_id === p.placeId) {
        highMatch = c;
        highReason = "相同 Google Place ID";
        break;
      }
      // 2. Corporate domain match
      if (p.corpDom && c.website_domain && c.website_domain === p.corpDom) {
        const sameCountry = !p.country || !c.country_en || p.country.toLowerCase() === c.country_en.toLowerCase();
        const sameName = p.normName && c.norm_name && p.normName === c.norm_name;
        if (sameCountry && sameName) {
          highMatch = c;
          highReason = `相同企业官网域名 (${p.corpDom}) 且名称/国家一致`;
          break;
        }
        suspects.push({
          company: summarizeMatch(c),
          reason: `共享官网域名 (${p.corpDom}) 但名称或国家不同（可能是集团/子公司/分支机构，禁止自动盲合）`,
        });
        continue;
      }
      // 3. Normalized name + country match
      if (p.normName && c.norm_name && p.normName === c.norm_name) {
        const sameCountry = p.country && c.country_en && p.country.toLowerCase() === c.country_en.toLowerCase();
        const sameCity = p.city && c.city && p.city.toLowerCase() === c.city.toLowerCase();
        if (sameCountry && sameCity) {
          highMatch = c;
          highReason = `相同规范化企业名 + 同国家 (${c.country_en}) + 同城市 (${c.city})`;
          break;
        }
        if (sameCountry) {
          suspects.push({
            company: summarizeMatch(c),
            reason: `同国家同名企业（城市信息不一致或待核实，请人工确认是否为分支机构）`,
          });
        }
      }
    }

    if (!highMatch) {
      if (p.email && contactByEmail.has(p.email)) {
        const cid = contactByEmail.get(p.email);
        const comp = byId.get(cid);
        if (comp && !suspects.some((s) => s.company.id === cid)) {
          suspects.push({ company: summarizeMatch(comp), reason: `存在相同联系人邮箱 (${p.email})` });
        }
      }
      if (p.phoneDigits && contactByPhone.has(p.phoneDigits)) {
        const cid = contactByPhone.get(p.phoneDigits);
        const comp = byId.get(cid);
        if (comp && !suspects.some((s) => s.company.id === cid)) {
          suspects.push({ company: summarizeMatch(comp), reason: `存在相同联系电话（可能为集团总机，请人工核对）` });
        }
      }
    }

    if (highMatch) {
      return {
        index: p.idx,
        status: "high_match",
        reason: highReason,
        match: summarizeMatch(highMatch),
      };
    }
    if (suspects.length) {
      return {
        index: p.idx,
        status: "suspect_duplicate",
        reason: suspects[0].reason,
        candidates: suspects.slice(0, 3),
      };
    }
    return {
      index: p.idx,
      status: "new",
      reason: "公海库暂无匹配记录",
    };
  });
}

export async function handleCompanyRoutes(request, env, cors, url) {
  const path = url.pathname;
  const method = request.method;

  // 1. Paginated Global Pool / My Follow-ups / Team Activity list (strictly paginated <=50, indexed)
  if (path === "/api/companies" && method === "GET") {
    const auth = await requireAuth(request, env, cors);
    if (!auth.ok) return auth.response;

    const view = url.searchParams.get("view") || "pool"; // pool | mine | team
    const country = String(url.searchParams.get("country") || "").trim();
    const poolStage = String(url.searchParams.get("pool_stage") || "").trim();
    const contactStatus = String(url.searchParams.get("contact_status") || "").trim();
    const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
    const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") || "30", 10) || 30));
    const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);

    const where = ["c.deleted_at IS NULL", "c.merged_into_id IS NULL"];
    const binds = [];

    if (country && country !== "ALL") {
      where.push("c.country_en = ?");
      binds.push(country);
    }
    if (poolStage && ["raw_pending", "verified_pool", "active"].includes(poolStage)) {
      where.push("c.pool_stage = ?");
      binds.push(poolStage);
    }
    if (contactStatus && contactStatus !== "all") {
      where.push("c.derived_contact_status = ?");
      binds.push(contactStatus);
    }
    if (view === "mine") {
      where.push(
        "(c.created_by = ? OR c.updated_by = ? OR EXISTS (SELECT 1 FROM contact_events ce WHERE ce.company_id = c.id AND ce.employee_id = ?))"
      );
      binds.push(auth.actor.id, auth.actor.id, auth.actor.id);
    }
    if (q) {
      where.push("(lower(c.canonical_name) LIKE ? OR lower(c.city) LIKE ? OR lower(c.website_domain) LIKE ? OR lower(c.product_summary) LIKE ?)");
      const like = `%${q}%`;
      binds.push(like, like, like, like);
    }

    const whereSql = where.join(" AND ");
    const cntRow = await env.DB
      .prepare(`SELECT COUNT(*) AS total FROM companies c WHERE ${whereSql}`)
      .bind(...binds)
      .first();

    const now = nowIso();
    const listRes = await env.DB
      .prepare(
        `SELECT c.*,
                l.lock_id AS active_lock_id, l.employee_id AS lock_emp_id, l.employee_name AS lock_emp_name,
                l.channel AS lock_channel, l.expires_at AS lock_expires_at
         FROM companies c
         LEFT JOIN contact_locks l ON l.company_id = c.id AND l.expires_at > ?
         WHERE ${whereSql}
         ORDER BY c.updated_at DESC
         LIMIT ? OFFSET ?`
      )
      .bind(now, ...binds, limit, offset)
      .all();

    const items = (listRes.results || []).map((r) => {
      const hasLock = Boolean(r.active_lock_id && r.lock_expires_at > now);
      const effectiveStatus =
        r.opt_out_status !== "none" || r.compliance_status === "blocked"
          ? "stopped"
          : hasLock
            ? "preparing"
            : r.derived_contact_status;
      return {
        id: r.id,
        canonical_name: r.canonical_name,
        aliases: safeJsonParse(r.aliases_json, []),
        country_en: r.country_en,
        city: r.city,
        address: r.address,
        website: r.website,
        website_domain: r.website_domain,
        industry_type: r.industry_type,
        buyer_type: r.buyer_type,
        product_summary: r.product_summary,
        pool_stage: r.pool_stage,
        parent_company_id: r.parent_company_id,
        google_place_id: r.google_place_id,
        compliance_status: r.compliance_status,
        opt_out_status: r.opt_out_status,
        stage: r.stage,
        next_follow_date: r.next_follow_date,
        cadence_step: r.cadence_step,
        cadence_label: r.cadence_label,
        note: r.note,
        derived_contact_status: effectiveStatus,
        last_event_summary: safeJsonParse(r.last_event_summary_json, {}),
        active_lock: hasLock
          ? {
              lock_id: r.active_lock_id,
              employee_id: r.lock_emp_id,
              employee_name: r.lock_emp_name,
              channel: r.lock_channel,
              expires_at: r.lock_expires_at,
            }
          : null,
        version: r.version,
        updated_at: r.updated_at,
        created_at: r.created_at,
      };
    });

    return json(
      {
        ok: true,
        total: Number((cntRow && cntRow.total) || 0),
        limit,
        offset,
        syncedAt: now,
        items,
      },
      200,
      cors
    );
  }

  // 2. Batch Dedupe API (Map / Radar / CSV / Manual — single batch query, no N+1)
  if (path === "/api/companies/dedupe-batch" && method === "POST") {
    const auth = await requireAuth(request, env, cors);
    if (!auth.ok) return auth.response;
    const body = await parseJsonBody(request, 256 * 1024);
    const items = Array.isArray(body.items) ? body.items : [];
    const results = await batchDedupeCandidates(env.DB, items);
    return json({ ok: true, results }, 200, cors);
  }

  // 3. Create Company in Unified Master Pool (with source provenance & Google Terms guard)
  if (path === "/api/companies" && method === "POST") {
    const auth = await requireAuth(request, env, cors);
    if (!auth.ok) return auth.response;
    const body = await parseJsonBody(request, 128 * 1024);

    // Reject storing raw Google Places business fields as company record
    if (String(body.source_type || "").toLowerCase() === "gmaps_raw") {
      return json(
        { error: "按 Google Maps Platform 条款，禁止将 Google 原始商户字段直接写入公海主库；请先独立核实官网信息后手工建档（仅可合法附带 Place ID）", code: "GMAPS_TERMS_BLOCKED" },
        400,
        cors
      );
    }

    const name = String(body.canonical_name || body.company || "").trim();
    const country = String(body.country_en || body.country || "").trim();
    if (!name || !country) {
      return json({ error: "请填写企业名称与所在国家" }, 400, cors);
    }
    const city = String(body.city || "").trim();
    const address = String(body.address || "").trim();
    const website = String(body.website || "").trim();
    const domRaw = extractCleanDomain(website || body.email || "");
    const corpDom = isPublicOrPlatformDomain(domRaw) ? "" : domRaw;
    const normName = normalizeCompanyName(name);
    const placeId = String(body.google_place_id || "").trim() || null;
    const sourceType = ["website", "worldbank", "customs_csv", "expo", "manual", "osm", "migration"].includes(body.source_type)
      ? body.source_type
      : "manual";
    const poolStage = ["raw_pending", "verified_pool", "active"].includes(body.pool_stage)
      ? body.pool_stage
      : "verified_pool";

    // Run dedupe unless caller explicitly passed force_create_new=true after human review
    if (!body.force_create_new) {
      const check = await batchDedupeCandidates(env.DB, [
        {
          canonical_name: name,
          country_en: country,
          city,
          website_domain: corpDom,
          google_place_id: placeId || "",
          email: body.email || "",
          phone: body.phone || "",
        },
      ]);
      const first = check[0];
      if (first && first.status === "high_match") {
        return json(
          {
            ok: false,
            code: "DUPLICATE_HIGH_MATCH",
            error: `公海库已存在高置信匹配企业「${first.match.canonical_name}」（${first.reason}），已避免重复建档`,
            match: first.match,
          },
          409,
          cors
        );
      }
      if (first && first.status === "suspect_duplicate") {
        return json(
          {
            ok: false,
            code: "DUPLICATE_SUSPECT_REVIEW",
            error: `检测到疑似重复企业（${first.reason}），请人工核对后选择关联已有企业或确认作为独立分支新建`,
            candidates: first.candidates,
          },
          409,
          cors
        );
      }
    }

    const id = String(body.id || "").trim() || randomId("cmp");
    const now = nowIso();
    const compStatus = ["unchecked", "review", "approved", "blocked"].includes(body.compliance_status)
      ? body.compliance_status
      : "unchecked";
    const optOut = ["none", "marketing_blocked", "all_blocked"].includes(body.opt_out_status)
      ? body.opt_out_status
      : "none";
    const derived = optOut !== "none" || compStatus === "blocked" ? "stopped" : "uncontacted";

    await env.DB
      .prepare(
        `INSERT INTO companies (
           id, canonical_name, norm_name, aliases_json, country_en, city, address, website, website_domain,
           industry_type, buyer_type, product_summary, pool_stage, parent_company_id, google_place_id,
           compliance_status, dd_json, opt_out_status, opt_out_meta_json, stage, next_follow_date,
           cadence_step, cadence_label, note, last_event_summary_json, derived_contact_status,
           version, merged_into_id, deleted_at, created_by, updated_by, schema_version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, 0, '', ?, '{}', ?, 1, NULL, NULL, ?, ?, 1, ?, ?)`
      )
      .bind(
        id,
        name,
        normName,
        JSON.stringify(Array.isArray(body.aliases) ? body.aliases : []),
        country,
        city,
        address,
        website,
        corpDom,
        String(body.industry_type || "").trim(),
        String(body.buyer_type || "").trim(),
        String(body.product_summary || body.product || "").trim(),
        poolStage,
        body.parent_company_id || null,
        placeId,
        compStatus,
        JSON.stringify(body.dd && typeof body.dd === "object" ? body.dd : {}),
        optOut,
        String(body.stage || "待开发"),
        String(body.next_follow_date || ""),
        String(body.note || ""),
        derived,
        auth.actor.id,
        auth.actor.id,
        now,
        now
      )
      .run();

    // Optional initial contact
    if (body.email || body.phone || body.contact_name) {
      const ctId = randomId("ct");
      await env.DB
        .prepare(
          `INSERT INTO company_contacts (id, company_id, name, role, email, email_verify_level, phone_e164, whatsapp_ok, source_type, verified_at, opt_out_flag, deleted_at, schema_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 1, ?, ?)`
        )
        .bind(
          ctId,
          id,
          String(body.contact_name || "").trim(),
          String(body.contact_role || "").trim(),
          String(body.email || "").trim().toLowerCase(),
          ["guessed", "mx_ok", "verified"].includes(body.email_verify_level) ? body.email_verify_level : "guessed",
          normalizePhoneDigits(body.phone || ""),
          body.whatsapp_ok ? 1 : 0,
          sourceType,
          now,
          now,
          now
        )
        .run();
    }

    // Record independent source provenance
    await env.DB
      .prepare(
        `INSERT INTO source_evidences (id, company_id, field_scope, source_type, source_url, license_class, verified_by, verified_at, schema_version, created_at)
         VALUES (?, ?, 'company', ?, ?, ?, ?, ?, 1, ?)`
      )
      .bind(
        randomId("src"),
        id,
        sourceType,
        String(body.source_url || website || "").slice(0, 300),
        sourceType === "osm" ? "ODbL" : "independent",
        auth.actor.id,
        now,
        now
      )
      .run();

    await writeAuditLog(env.DB, auth.actor, "CREATE_COMPANY", "company", id, `${name} (${country}) via ${sourceType}`);
    const created = await env.DB.prepare("SELECT * FROM companies WHERE id = ?").bind(id).first();
    return json({ ok: true, company: created }, 201, cors);
  }

  // 4. Lossless Reversible Merge (super_admin | manager)
  if (path === "/api/companies/merge" && method === "POST") {
    const auth = await requireAuth(request, env, cors, { roles: ["super_admin", "manager"] });
    if (!auth.ok) return auth.response;
    const body = await parseJsonBody(request, 32768);
    const sourceId = String(body.source_id || "").trim();
    const targetId = String(body.target_id || "").trim();
    if (!sourceId || !targetId || sourceId === targetId) {
      return json({ error: "请提供不同的源企业 ID 与目标主档 ID" }, 400, cors);
    }

    const src = await env.DB.prepare("SELECT * FROM companies WHERE id = ? AND deleted_at IS NULL AND merged_into_id IS NULL").bind(sourceId).first();
    const tgt = await env.DB.prepare("SELECT * FROM companies WHERE id = ? AND deleted_at IS NULL AND merged_into_id IS NULL").bind(targetId).first();
    if (!src || !tgt) return json({ error: "源企业或目标企业不存在或已被合并" }, 404, cors);

    const now = nowIso();
    // Preserve full reversible snapshot of reassigned child IDs in audit log
    const movedContacts = (await env.DB.prepare("SELECT id FROM company_contacts WHERE company_id = ?").bind(sourceId).all()).results.map((r) => r.id);
    const movedEvents = (await env.DB.prepare("SELECT event_id FROM contact_events WHERE company_id = ?").bind(sourceId).all()).results.map((r) => r.event_id);
    const movedQuotes = (await env.DB.prepare("SELECT quote_id FROM quote_records WHERE company_id = ?").bind(sourceId).all()).results.map((r) => r.quote_id);
    const movedCompLogs = (await env.DB.prepare("SELECT log_id FROM compliance_order_logs WHERE company_id = ?").bind(sourceId).all()).results.map((r) => r.log_id);
    const movedSources = (await env.DB.prepare("SELECT id FROM source_evidences WHERE company_id = ?").bind(sourceId).all()).results.map((r) => r.id);

    await env.DB.prepare("UPDATE company_contacts SET company_id = ?, updated_at = ? WHERE company_id = ?").bind(targetId, now, sourceId).run();
    await env.DB.prepare("UPDATE contact_events SET company_id = ? WHERE company_id = ?").bind(targetId, sourceId).run();
    await env.DB.prepare("UPDATE quote_records SET company_id = ?, updated_at = ? WHERE company_id = ?").bind(targetId, now, sourceId).run();
    await env.DB.prepare("UPDATE compliance_order_logs SET company_id = ? WHERE company_id = ?").bind(targetId, sourceId).run();
    await env.DB.prepare("UPDATE source_evidences SET company_id = ? WHERE company_id = ?").bind(targetId, sourceId).run();
    await env.DB.prepare("DELETE FROM contact_locks WHERE company_id = ?").bind(sourceId).run();

    // Merge aliases, product_summary, monotonic opt_out & compliance_status onto target
    const aliases = new Set(safeJsonParse(tgt.aliases_json, []));
    if (src.canonical_name && src.canonical_name !== tgt.canonical_name) aliases.add(src.canonical_name);
    safeJsonParse(src.aliases_json, []).forEach((a) => aliases.add(a));

    const mergedOptOut = monotonicOptOut(tgt.opt_out_status, src.opt_out_status);
    const mergedComp = monotonicCompliance(tgt.compliance_status, src.compliance_status, false);
    const mergedProducts = [tgt.product_summary, src.product_summary].filter(Boolean).join(" / ").slice(0, 400);
    const mergedNote = [tgt.note, src.note ? `[合并自 ${src.canonical_name}] ${src.note}` : ""].filter(Boolean).join("\n");

    await env.DB
      .prepare(
        `UPDATE companies
         SET aliases_json = ?, opt_out_status = ?, compliance_status = ?, product_summary = ?,
             note = ?, version = version + 1, updated_by = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(JSON.stringify(Array.from(aliases)), mergedOptOut, mergedComp, mergedProducts, mergedNote, auth.actor.id, now, targetId)
      .run();

    await env.DB
      .prepare("UPDATE companies SET merged_into_id = ?, updated_by = ?, updated_at = ? WHERE id = ?")
      .bind(targetId, auth.actor.id, now, sourceId)
      .run();

    await recomputeCompanyDerivedState(env.DB, targetId);

    const undoManifest = {
      sourceId,
      targetId,
      movedContacts,
      movedEvents,
      movedQuotes,
      movedCompLogs,
      movedSources,
    };
    const auditId = await writeAuditLog(env.DB, auth.actor, "MERGE_COMPANY", "company", targetId, JSON.stringify(undoManifest));
    return json({ ok: true, targetId, sourceId, auditId, moved: { contacts: movedContacts.length, events: movedEvents.length, quotes: movedQuotes.length, complianceLogs: movedCompLogs.length } }, 200, cors);
  }

  // 5. Reversible Unmerge (super_admin)
  if (path === "/api/companies/unmerge" && method === "POST") {
    const auth = await requireAuth(request, env, cors, { roles: ["super_admin"] });
    if (!auth.ok) return auth.response;
    const body = await parseJsonBody(request, 16384);
    const auditId = String(body.audit_id || "").trim();
    const aud = await env.DB.prepare("SELECT * FROM audit_logs WHERE id = ? AND action = 'MERGE_COMPANY'").bind(auditId).first();
    if (!aud) return json({ error: "未找到对应的合并审计记录" }, 404, cors);

    const m = safeJsonParse(aud.diff_summary, null);
    if (!m || !m.sourceId || !m.targetId) return json({ error: "合并还原清单损坏" }, 400, cors);
    const now = nowIso();

    await env.DB.prepare("UPDATE companies SET merged_into_id = NULL, updated_by = ?, updated_at = ? WHERE id = ?").bind(auth.actor.id, now, m.sourceId).run();
    for (const cid of m.movedContacts || []) {
      await env.DB.prepare("UPDATE company_contacts SET company_id = ?, updated_at = ? WHERE id = ?").bind(m.sourceId, now, cid).run();
    }
    for (const eid of m.movedEvents || []) {
      await env.DB.prepare("UPDATE contact_events SET company_id = ? WHERE event_id = ?").bind(m.sourceId, eid).run();
    }
    for (const qid of m.movedQuotes || []) {
      await env.DB.prepare("UPDATE quote_records SET company_id = ?, updated_at = ? WHERE quote_id = ?").bind(m.sourceId, now, qid).run();
    }
    for (const lid of m.movedCompLogs || []) {
      await env.DB.prepare("UPDATE compliance_order_logs SET company_id = ? WHERE log_id = ?").bind(m.sourceId, lid).run();
    }
    for (const sid of m.movedSources || []) {
      await env.DB.prepare("UPDATE source_evidences SET company_id = ? WHERE id = ?").bind(m.sourceId, sid).run();
    }
    await recomputeCompanyDerivedState(env.DB, m.targetId);
    await recomputeCompanyDerivedState(env.DB, m.sourceId);
    await writeAuditLog(env.DB, auth.actor, "UNMERGE_COMPANY", "company", m.sourceId, `restored from merge audit ${auditId}`);
    return json({ ok: true, restoredSourceId: m.sourceId, targetId: m.targetId }, 200, cors);
  }

  // 6. OSM Raw Pending Pool (Physically isolated ODbL table)
  if (path === "/api/osm-pool" && method === "GET") {
    const auth = await requireAuth(request, env, cors);
    if (!auth.ok) return auth.response;
    const country = String(url.searchParams.get("country") || "").trim();
    const onlyUnpromoted = url.searchParams.get("all") !== "1";
    const where = [];
    const binds = [];
    if (country && country !== "ALL") {
      where.push("country_en = ?");
      binds.push(country);
    }
    if (onlyUnpromoted) where.push("promoted_company_id IS NULL");
    const sqlWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = await env.DB
      .prepare(`SELECT * FROM raw_osm_pool ${sqlWhere} ORDER BY collected_at DESC LIMIT 60`)
      .bind(...binds)
      .all();
    return json({ ok: true, license: "ODbL 1.0 (Collective Database isolated table)", items: rows.results || [] }, 200, cors);
  }

  if (path === "/api/osm-pool/ingest" && method === "POST") {
    const auth = await requireAuth(request, env, cors);
    if (!auth.ok) return auth.response;
    const body = await parseJsonBody(request, 256 * 1024);
    const leads = (Array.isArray(body.items) ? body.items : []).slice(0, 100);
    const now = nowIso();
    let inserted = 0;
    for (const it of leads) {
      if (!it || it._source === "gmaps") continue; // Strict defense: NEVER allow Google rows into OSM pool
      const nm = String(it.company || it.name || "").trim();
      const ctry = String(it.country || it.country_en || "").trim();
      if (!nm || !ctry) continue;
      const osmRef = String(it.osm_ref || it.mapsUrl || `${ctry}|${it.city || ""}|${nm.toLowerCase()}`).slice(0, 240);
      const id = randomId("osm");
      const res = await env.DB
        .prepare(
          `INSERT OR IGNORE INTO raw_osm_pool (id, osm_ref, country_en, city, name, category, raw_tags_json, collected_by, collected_at, promoted_company_id, license_tag, schema_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'ODbL', 1, ?, ?)`
        )
        .bind(
          id,
          osmRef,
          ctry,
          String(it.city || "").trim(),
          nm,
          String(it.category || "").trim(),
          JSON.stringify({ phone: it.phone || "", email: it.email || "", website: it.website || "", address: it.address || "", mapsUrl: it.mapsUrl || "" }),
          auth.actor.id,
          now,
          now,
          now
        )
        .run();
      if (res && res.meta && res.meta.changes > 0) inserted++;
    }
    return json({ ok: true, ingested: inserted, totalSubmitted: leads.length }, 200, cors);
  }

  const osmPromMatch = path.match(/^\/api\/osm-pool\/([^/]+)\/promote$/);
  if (osmPromMatch && method === "POST") {
    const auth = await requireAuth(request, env, cors);
    if (!auth.ok) return auth.response;
    const osmId = decodeURIComponent(osmPromMatch[1]);
    const raw = await env.DB.prepare("SELECT * FROM raw_osm_pool WHERE id = ?").bind(osmId).first();
    if (!raw) return json({ error: "OSM 待核实线索不存在" }, 404, cors);
    if (raw.promoted_company_id) {
      return json({ ok: true, alreadyPromoted: true, companyId: raw.promoted_company_id }, 200, cors);
    }
    const body = await parseJsonBody(request, 32768);
    const tags = safeJsonParse(raw.raw_tags_json, {});
    const website = String(body.website || tags.website || "").trim();
    const domRaw = extractCleanDomain(website || body.email || tags.email || "");
    const corpDom = isPublicOrPlatformDomain(domRaw) ? "" : domRaw;
    const now = nowIso();
    const compId = randomId("cmp");

    await env.DB
      .prepare(
        `INSERT INTO companies (
           id, canonical_name, norm_name, aliases_json, country_en, city, address, website, website_domain,
           industry_type, buyer_type, product_summary, pool_stage, compliance_status, dd_json, opt_out_status,
           opt_out_meta_json, stage, next_follow_date, cadence_step, cadence_label, note, last_event_summary_json,
           derived_contact_status, version, created_by, updated_by, schema_version, created_at, updated_at
         ) VALUES (?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, 'verified_pool', 'unchecked', '{}', 'none', '{}', '待开发', '', 0, '', ?, '{}', 'uncontacted', 1, ?, ?, 1, ?, ?)`
      )
      .bind(
        compId,
        String(body.canonical_name || raw.name).trim(),
        normalizeCompanyName(body.canonical_name || raw.name),
        raw.country_en,
        String(body.city || raw.city || "").trim(),
        String(body.address || tags.address || "").trim(),
        website,
        corpDom,
        raw.category,
        String(body.buyer_type || "").trim(),
        String(body.product_summary || "").trim(),
        String(body.note || `核实自 OSM 线索池 (${raw.osm_ref})`),
        auth.actor.id,
        auth.actor.id,
        now,
        now
      )
      .run();

    if (body.email || body.phone || tags.email || tags.phone) {
      await env.DB
        .prepare(
          `INSERT INTO company_contacts (id, company_id, name, role, email, email_verify_level, phone_e164, whatsapp_ok, source_type, verified_at, opt_out_flag, schema_version, created_at, updated_at)
           VALUES (?, ?, '', '', ?, 'guessed', ?, 0, 'osm', ?, 0, 1, ?, ?)`
        )
        .bind(
          randomId("ct"),
          compId,
          String(body.email || tags.email || "").trim().toLowerCase(),
          normalizePhoneDigits(body.phone || tags.phone || ""),
          now,
          now,
          now
        )
        .run();
    }

    await env.DB
      .prepare(
        `INSERT INTO source_evidences (id, company_id, field_scope, source_type, source_url, license_class, verified_by, verified_at, schema_version, created_at)
         VALUES (?, ?, 'company', 'osm', ?, 'ODbL', ?, ?, 1, ?)`
      )
      .bind(randomId("src"), compId, String(tags.mapsUrl || website || ""), auth.actor.id, now, now)
      .run();

    await env.DB
      .prepare("UPDATE raw_osm_pool SET promoted_company_id = ?, updated_at = ? WHERE id = ?")
      .bind(compId, now, osmId)
      .run();

    await writeAuditLog(env.DB, auth.actor, "PROMOTE_OSM_TO_POOL", "company", compId, `from raw_osm_pool=${osmId}`);
    return json({ ok: true, companyId: compId }, 201, cors);
  }

  // 7. Team Search Task Metadata Ledger (metadata ONLY — never stores Google raw results)
  if (path === "/api/scrape-tasks" && method === "POST") {
    const auth = await requireAuth(request, env, cors);
    if (!auth.ok) return auth.response;
    const body = await parseJsonBody(request, 16384);
    const id = randomId("tsk");
    const now = nowIso();
    await env.DB
      .prepare(
        `INSERT INTO scrape_task_logs (id, country_en, city, radius_km, keyword, profile_key, engine, employee_id, raw_count, verified_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        String(body.country_en || "").slice(0, 60),
        String(body.city || "").slice(0, 80),
        Math.min(100, Math.max(1, parseInt(body.radius_km || 30, 10) || 30)),
        String(body.keyword || "").slice(0, 120),
        String(body.profile_key || "all").slice(0, 40),
        body.engine === "gmaps" ? "gmaps" : "osm",
        auth.actor.id,
        Math.max(0, parseInt(body.raw_count || 0, 10) || 0),
        Math.max(0, parseInt(body.verified_count || 0, 10) || 0),
        now
      )
      .run();
    return json({ ok: true, id }, 201, cors);
  }

  if (path === "/api/scrape-tasks" && method === "GET") {
    const auth = await requireAuth(request, env, cors);
    if (!auth.ok) return auth.response;
    const rows = await env.DB
      .prepare(
        `SELECT t.*, e.display_name AS employee_name
         FROM scrape_task_logs t
         LEFT JOIN employees e ON e.id = t.employee_id
         ORDER BY t.created_at DESC LIMIT 40`
      )
      .all();
    return json({ ok: true, tasks: rows.results || [] }, 200, cors);
  }

  // 8. Company Detail / Update / Child Contacts, Quotes & Compliance Logs
  const compContactMatch = path.match(/^\/api\/companies\/([^/]+)\/contacts$/);
  if (compContactMatch && method === "POST") {
    const auth = await requireAuth(request, env, cors);
    if (!auth.ok) return auth.response;
    const compId = decodeURIComponent(compContactMatch[1]);
    const comp = await env.DB.prepare("SELECT id FROM companies WHERE id = ? AND deleted_at IS NULL").bind(compId).first();
    if (!comp) return json({ error: "企业不存在" }, 404, cors);
    const body = await parseJsonBody(request, 16384);
    const name = String(body.name || "").trim().slice(0, 80);
    const role = String(body.role || "").trim().slice(0, 80);
    const email = String(body.email || "").trim().toLowerCase().slice(0, 120);
    const phoneDigits = normalizePhoneDigits(body.phone || body.phone_e164 || "");
    if (!name && !email && !phoneDigits) {
      return json({ error: "请至少填写联系人姓名、邮箱或电话之一" }, 400, cors);
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: "联系人邮箱格式无效" }, 400, cors);
    }
    const verifyLevel = ["guessed", "mx_ok", "verified"].includes(body.email_verify_level) ? body.email_verify_level : "guessed";
    const id = randomId("ct");
    const now = nowIso();
    await env.DB
      .prepare(
        `INSERT INTO company_contacts (id, company_id, name, role, email, email_verify_level, phone_e164, whatsapp_ok, source_type, verified_at, opt_out_flag, schema_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, 0, 1, ?, ?)`
      )
      .bind(id, compId, name, role, email, verifyLevel, phoneDigits, body.whatsapp_ok ? 1 : 0, now, now, now)
      .run();
    const created = await env.DB.prepare("SELECT * FROM company_contacts WHERE id = ?").bind(id).first();
    return json({ ok: true, contact: created }, 201, cors);
  }

  const compQuoteMatch = path.match(/^\/api\/companies\/([^/]+)\/quotes$/);
  if (compQuoteMatch && method === "POST") {
    const auth = await requireAuth(request, env, cors);
    if (!auth.ok) return auth.response;
    const compId = decodeURIComponent(compQuoteMatch[1]);
    const comp = await env.DB
      .prepare("SELECT id, canonical_name, compliance_status, opt_out_status FROM companies WHERE id = ? AND deleted_at IS NULL")
      .bind(compId)
      .first();
    if (!comp) return json({ error: "企业不存在" }, 404, cors);

    const body = await parseJsonBody(request, 65536);
    const quoteTier = body.quote_tier === "formal" ? "formal" : body.quote_tier === "indicative" ? "indicative" : "";
    if (!quoteTier) {
      return json({ error: "quote_tier 必须为 indicative 或 formal" }, 400, cors);
    }
    const sentConfirmed = body.sent_confirmed ? 1 : 0;

    // D06: Authoritative server-side business & compliance gates (cannot be bypassed by direct API calls!)
    if (comp.compliance_status === "blocked") {
      return json(
        { error: "⛔ 该企业处于合规阻断状态（blocked），禁止保存正式或已发报价记录", code: "COMPLIANCE_BLOCKED_QUOTE_FORBIDDEN" },
        403,
        cors
      );
    }
    if (comp.opt_out_status !== "none" && (quoteTier === "formal" || sentConfirmed === 1)) {
      return json(
        { error: "⛔ 该企业已登记拒绝/退订（" + comp.opt_out_status + "），禁止出具正式报价或标记已发送", code: "OPTOUT_QUOTE_FORBIDDEN" },
        403,
        cors
      );
    }
    if (quoteTier === "formal" && comp.compliance_status !== "approved") {
      return json(
        { error: "⚠️ 出具正式报价（Formal）前须先完成客户背调并审批通过（approved），当前状态：" + comp.compliance_status, code: "DD_APPROVAL_REQUIRED" },
        403,
        cors
      );
    }

    const payload = body.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return json({ error: "缺少有效报价明细 payload 对象" }, 400, cors);
    }
    // Validate numeric integrity across all known pricing fields (reject negative, NaN, Infinity, qty <= 0)
    const nonNegFields = ["fob", "cif", "fobTotal", "cifTotal", "unitPrice", "unitFob", "unitCif", "factoryRmb", "freightUsd", "localRmb", "marginPct", "price", "total", "amount"];
    for (const k of nonNegFields) {
      if (payload[k] !== undefined && payload[k] !== null && payload[k] !== "") {
        const num = Number(payload[k]);
        if (!Number.isFinite(num) || num < 0) {
          return json({ error: `报价字段 ${k} 数值无效（严禁负数、NaN 或无穷大）`, code: "INVALID_QUOTE_PAYLOAD" }, 400, cors);
        }
      }
    }
    if (payload.qty !== undefined && payload.qty !== null && payload.qty !== "") {
      const qNum = Number(payload.qty);
      if (!Number.isFinite(qNum) || qNum <= 0) {
        return json({ error: "报价数量 qty 必须大于 0", code: "INVALID_QUOTE_PAYLOAD" }, 400, cors);
      }
    }
    if (payload.fx !== undefined && payload.fx !== null && payload.fx !== "") {
      const fxNum = Number(payload.fx);
      if (!Number.isFinite(fxNum) || fxNum <= 0) {
        return json({ error: "核算汇率 fx 必须大于 0", code: "INVALID_QUOTE_PAYLOAD" }, 400, cors);
      }
    }

    const quoteId = String(body.quote_id || "").trim() || randomId("qt");
    const refNo = String(body.ref_no || "").trim().slice(0, 64);
    const now = nowIso();
    await env.DB
      .prepare(
        `INSERT INTO quote_records (quote_id, company_id, ref_no, quote_tier, profile_version, payload_json, sent_confirmed, created_by, schema_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(quote_id) DO UPDATE SET
           ref_no = excluded.ref_no, quote_tier = excluded.quote_tier, payload_json = excluded.payload_json,
           sent_confirmed = excluded.sent_confirmed, updated_at = excluded.updated_at`
      )
      .bind(
        quoteId,
        compId,
        refNo,
        quoteTier,
        parseInt(body.profile_version || 1, 10) || 1,
        JSON.stringify(payload),
        sentConfirmed,
        auth.actor.id,
        now,
        now
      )
      .run();

    if (quoteTier === "formal" || sentConfirmed === 1) {
      await writeAuditLog(
        env.DB,
        auth.actor,
        "SAVE_CLOUD_QUOTE",
        "company",
        compId,
        `quote_id=${quoteId}; tier=${quoteTier}; sent=${sentConfirmed}; ref=${refNo}`
      );
    }
    return json({ ok: true, quote_id: quoteId, quote_tier: quoteTier, sent_confirmed: sentConfirmed }, 201, cors);
  }

  const compLogMatch = path.match(/^\/api\/companies\/([^/]+)\/compliance-logs$/);
  if (compLogMatch && method === "POST") {
    const auth = await requireAuth(request, env, cors);
    if (!auth.ok) return auth.response;
    const compId = decodeURIComponent(compLogMatch[1]);
    const comp = await env.DB
      .prepare("SELECT id, compliance_status FROM companies WHERE id = ? AND deleted_at IS NULL")
      .bind(compId)
      .first();
    if (!comp) return json({ error: "企业不存在" }, 404, cors);

    const body = await parseJsonBody(request, 65536);
    const orderRef = String(body.order_ref || "").trim().slice(0, 80);
    const decision = String(body.decision || "review").trim();
    if (!["approved", "review", "blocked", "pending"].includes(decision)) {
      return json({ error: "无效合规结论 decision（仅允许 approved / review / blocked / pending）" }, 400, cors);
    }
    const checks = body.checks;
    const validChecksObj = checks && typeof checks === "object";
    const confirmedCount = Array.isArray(checks)
      ? checks.filter((c) => Boolean(c && (c === true || c.checked || c.ok || c.status === "ok" || c.passed))).length
      : validChecksObj
        ? Object.keys(checks).filter((k) => Boolean(checks[k])).length
        : 0;

    // D06: Reject empty/unverified approved compliance records and blocked-company approvals!
    if (decision === "approved") {
      if (comp.compliance_status === "blocked") {
        return json({ error: "⛔ 该企业处于合规阻断状态，禁止归档为逐单合规通过（approved）", code: "COMPLIANCE_BLOCKED_APPROVAL_FORBIDDEN" }, 403, cors);
      }
      if (!orderRef || orderRef.length < 2) {
        return json({ error: "归档逐单合规通过（approved）必须填写有效订单/报价编号 order_ref", code: "ORDER_REF_REQUIRED" }, 400, cors);
      }
      if (confirmedCount < 1) {
        return json({ error: "归档逐单合规通过（approved）必须包含已核查确认项，禁止提交空 checks", code: "COMPLIANCE_CHECKS_REQUIRED" }, 400, cors);
      }
    }

    const logId = String(body.log_id || "").trim() || randomId("pcl");
    const now = nowIso();
    await env.DB
      .prepare(
        `INSERT INTO compliance_order_logs (log_id, order_ref, company_id, decision, checks_json, reviewer, saved_at, schema_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(log_id) DO UPDATE SET order_ref = excluded.order_ref, decision = excluded.decision, checks_json = excluded.checks_json, reviewer = excluded.reviewer, saved_at = excluded.saved_at`
      )
      .bind(
        logId,
        orderRef,
        compId,
        decision,
        JSON.stringify(validChecksObj ? checks : {}),
        auth.actor.display_name,
        now,
        now
      )
      .run();
    await writeAuditLog(env.DB, auth.actor, "SAVE_COMPLIANCE_LOG", "company", compId, `log_id=${logId}; order=${orderRef}; decision=${decision}; checks=${confirmedCount}`);
    return json({ ok: true, log_id: logId, decision }, 201, cors);
  }

  const compIdMatch = path.match(/^\/api\/companies\/([^/]+)$/);
  if (compIdMatch && method === "GET") {
    const auth = await requireAuth(request, env, cors);
    if (!auth.ok) return auth.response;
    const compId = decodeURIComponent(compIdMatch[1]);
    const comp = await env.DB.prepare("SELECT * FROM companies WHERE id = ?").bind(compId).first();
    if (!comp) return json({ error: "企业档案不存在" }, 404, cors);
    const now = nowIso();
    const [contacts, events, quotes, compLogs, sources, activeLock] = await Promise.all([
      env.DB.prepare("SELECT * FROM company_contacts WHERE company_id = ? AND deleted_at IS NULL ORDER BY created_at ASC").bind(compId).all(),
      env.DB.prepare("SELECT * FROM contact_events WHERE company_id = ? ORDER BY occurred_at DESC LIMIT 80").bind(compId).all(),
      env.DB.prepare("SELECT * FROM quote_records WHERE company_id = ? ORDER BY created_at DESC LIMIT 30").bind(compId).all(),
      env.DB.prepare("SELECT * FROM compliance_order_logs WHERE company_id = ? ORDER BY saved_at DESC LIMIT 30").bind(compId).all(),
      env.DB.prepare("SELECT * FROM source_evidences WHERE company_id = ? ORDER BY verified_at DESC LIMIT 20").bind(compId).all(),
      env.DB.prepare("SELECT * FROM contact_locks WHERE company_id = ? AND expires_at > ?").bind(compId, now).first(),
    ]);
    return json(
      {
        ok: true,
        company: {
          ...comp,
          aliases: safeJsonParse(comp.aliases_json, []),
          dd: safeJsonParse(comp.dd_json, {}),
          opt_out_meta: safeJsonParse(comp.opt_out_meta_json, {}),
          last_event_summary: safeJsonParse(comp.last_event_summary_json, {}),
        },
        contacts: contacts.results || [],
        events: events.results || [],
        quotes: (quotes.results || []).map((q) => ({ ...q, payload: safeJsonParse(q.payload_json, {}) })),
        complianceLogs: (compLogs.results || []).map((l) => ({ ...l, checks: safeJsonParse(l.checks_json, {}) })),
        sources: sources.results || [],
        activeLock: activeLock || null,
      },
      200,
      cors
    );
  }

  if (compIdMatch && method === "PATCH") {
    const auth = await requireAuth(request, env, cors);
    if (!auth.ok) return auth.response;
    const compId = decodeURIComponent(compIdMatch[1]);
    const body = await parseJsonBody(request, 65536);

    const cur = await env.DB.prepare("SELECT * FROM companies WHERE id = ? AND deleted_at IS NULL").bind(compId).first();
    if (!cur) return json({ error: "企业档案不存在" }, 404, cors);

    // Optimistic concurrency check to prevent stale offline device overwriting newer server changes
    if (body.expected_version != null && Number(body.expected_version) !== Number(cur.version)) {
      return json(
        {
          error: `并发版本冲突：服务器已更新至 v${cur.version}（你的本地副本为 v${body.expected_version}），请刷新最新资料后再修改`,
          code: "VERSION_CONFLICT",
          latestVersion: cur.version,
          latestCompany: cur,
        },
        409,
        cors
      );
    }

    const now = nowIso();
    const nextName = typeof body.canonical_name === "string" && body.canonical_name.trim() ? body.canonical_name.trim() : cur.canonical_name;
    const nextWebsite = typeof body.website === "string" ? body.website.trim() : cur.website;
    const domRaw = extractCleanDomain(nextWebsite);
    const nextDom = nextWebsite ? (isPublicOrPlatformDomain(domRaw) ? cur.website_domain : domRaw) : cur.website_domain;

    // Monotonic non-downgrade protection for opt_out_status & compliance_status='blocked'
    const nextOptOut = body.opt_out_status ? monotonicOptOut(cur.opt_out_status, body.opt_out_status) : cur.opt_out_status;
    const allowUnblock = auth.actor.role === "super_admin" && Boolean(body.admin_compliance_override_reason);
    const nextCompliance = body.compliance_status
      ? monotonicCompliance(cur.compliance_status, body.compliance_status, allowUnblock)
      : cur.compliance_status;

    const nextPoolStage = ["raw_pending", "verified_pool", "active"].includes(body.pool_stage) ? body.pool_stage : cur.pool_stage;
    const nextOptOutMeta =
      nextOptOut !== cur.opt_out_status
        ? JSON.stringify({
            updated_by: auth.actor.display_name,
            updated_at: now,
            reason: String(body.opt_out_reason || "客户拒绝/退订").slice(0, 200),
          })
        : cur.opt_out_meta_json;

    const res = await env.DB
      .prepare(
        `UPDATE companies
         SET canonical_name = ?, norm_name = ?, city = ?, address = ?, website = ?, website_domain = ?,
             industry_type = ?, buyer_type = ?, product_summary = ?, pool_stage = ?,
             compliance_status = ?, dd_json = ?, opt_out_status = ?, opt_out_meta_json = ?,
             stage = ?, next_follow_date = ?, cadence_step = ?, cadence_label = ?, note = ?,
             version = version + 1, updated_by = ?, updated_at = ?
         WHERE id = ? AND version = ?`
      )
      .bind(
        nextName,
        normalizeCompanyName(nextName),
        typeof body.city === "string" ? body.city.trim() : cur.city,
        typeof body.address === "string" ? body.address.trim() : cur.address,
        nextWebsite,
        nextDom,
        typeof body.industry_type === "string" ? body.industry_type.trim() : cur.industry_type,
        typeof body.buyer_type === "string" ? body.buyer_type.trim() : cur.buyer_type,
        typeof body.product_summary === "string" ? body.product_summary.trim() : cur.product_summary,
        nextPoolStage,
        nextCompliance,
        body.dd && typeof body.dd === "object" ? JSON.stringify(body.dd) : cur.dd_json,
        nextOptOut,
        nextOptOutMeta,
        typeof body.stage === "string" ? body.stage.trim() : cur.stage,
        typeof body.next_follow_date === "string" ? body.next_follow_date.trim() : cur.next_follow_date,
        body.cadence_step != null ? parseInt(body.cadence_step, 10) || 0 : cur.cadence_step,
        typeof body.cadence_label === "string" ? body.cadence_label.trim() : cur.cadence_label,
        typeof body.note === "string" ? body.note : cur.note,
        auth.actor.id,
        now,
        compId,
        cur.version
      )
      .run();

    if (!res || !res.meta || res.meta.changes === 0) {
      return json({ error: "并发更新冲突，请刷新后重试", code: "VERSION_CONFLICT" }, 409, cors);
    }

    // Optional contact add
    if (body.add_contact && typeof body.add_contact === "object") {
      const ac = body.add_contact;
      await env.DB
        .prepare(
          `INSERT INTO company_contacts (id, company_id, name, role, email, email_verify_level, phone_e164, whatsapp_ok, source_type, verified_at, opt_out_flag, schema_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, 0, 1, ?, ?)`
        )
        .bind(
          randomId("ct"),
          compId,
          String(ac.name || "").trim(),
          String(ac.role || "").trim(),
          String(ac.email || "").trim().toLowerCase(),
          ["guessed", "mx_ok", "verified"].includes(ac.email_verify_level) ? ac.email_verify_level : "guessed",
          normalizePhoneDigits(ac.phone || ""),
          ac.whatsapp_ok ? 1 : 0,
          now,
          now,
          now
        )
        .run();
    }

    await recomputeCompanyDerivedState(env.DB, compId);
    if (nextOptOut !== cur.opt_out_status || nextCompliance !== cur.compliance_status) {
      await writeAuditLog(
        env.DB,
        auth.actor,
        "UPDATE_COMPANY_COMPLIANCE_OR_OPTOUT",
        "company",
        compId,
        `opt_out:${cur.opt_out_status}->${nextOptOut}; compliance:${cur.compliance_status}->${nextCompliance}`
      );
    }
    const updated = await env.DB.prepare("SELECT * FROM companies WHERE id = ?").bind(compId).first();
    return json({ ok: true, company: updated }, 200, cors);
  }

  return null;
}
