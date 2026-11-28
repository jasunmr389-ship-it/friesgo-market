-- FriesGo Global V2.1 M2-A: Unified Cloud Company Pool, Employee Auth & Anti-Duplicate Schema
-- Strictly additive / backward-compatible schema migration v1.

CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  login_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('super_admin','manager','staff')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  pwd_hash TEXT NOT NULL,
  pwd_salt TEXT NOT NULL,
  pwd_iter INTEGER NOT NULL DEFAULT 100000,
  totp_secret_enc TEXT NOT NULL DEFAULT '',
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  recovery_codes_hash_json TEXT NOT NULL DEFAULT '[]',
  must_reset_pwd INTEGER NOT NULL DEFAULT 0,
  gmaps_monthly_cap INTEGER NOT NULL DEFAULT 250,
  last_totp_step INTEGER NOT NULL DEFAULT 0,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  employee_id TEXT NOT NULL,
  device_label TEXT NOT NULL DEFAULT '',
  ua_fingerprint TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_emp ON sessions(employee_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS login_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  fail_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  norm_name TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  country_en TEXT NOT NULL,
  city TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  website_domain TEXT NOT NULL DEFAULT '',
  industry_type TEXT NOT NULL DEFAULT '',
  buyer_type TEXT NOT NULL DEFAULT '',
  product_summary TEXT NOT NULL DEFAULT '',
  pool_stage TEXT NOT NULL DEFAULT 'verified_pool' CHECK(pool_stage IN ('raw_pending','verified_pool','active')),
  parent_company_id TEXT,
  google_place_id TEXT,
  compliance_status TEXT NOT NULL DEFAULT 'unchecked' CHECK(compliance_status IN ('unchecked','review','approved','blocked')),
  dd_json TEXT NOT NULL DEFAULT '{}',
  opt_out_status TEXT NOT NULL DEFAULT 'none' CHECK(opt_out_status IN ('none','marketing_blocked','all_blocked')),
  opt_out_meta_json TEXT NOT NULL DEFAULT '{}',
  stage TEXT NOT NULL DEFAULT '待开发',
  next_follow_date TEXT NOT NULL DEFAULT '',
  cadence_step INTEGER NOT NULL DEFAULT 0,
  cadence_label TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  last_event_summary_json TEXT NOT NULL DEFAULT '{}',
  derived_contact_status TEXT NOT NULL DEFAULT 'uncontacted' CHECK(derived_contact_status IN ('uncontacted','preparing','contacted_no_reply','following_up','inquired','quoted','stopped')),
  version INTEGER NOT NULL DEFAULT 1,
  merged_into_id TEXT,
  deleted_at TEXT,
  created_by TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT '',
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_companies_country_stage ON companies(country_en, pool_stage, deleted_at, merged_into_id);
CREATE INDEX IF NOT EXISTS idx_companies_domain ON companies(website_domain);
CREATE INDEX IF NOT EXISTS idx_companies_name_country ON companies(norm_name, country_en);
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_place_id ON companies(google_place_id) WHERE google_place_id IS NOT NULL AND google_place_id != '';
CREATE INDEX IF NOT EXISTS idx_companies_updated ON companies(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_companies_next_follow ON companies(next_follow_date, deleted_at);

CREATE TABLE IF NOT EXISTS company_contacts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  email_verify_level TEXT NOT NULL DEFAULT 'guessed' CHECK(email_verify_level IN ('guessed','mx_ok','verified')),
  phone_e164 TEXT NOT NULL DEFAULT '',
  whatsapp_ok INTEGER NOT NULL DEFAULT 0,
  source_type TEXT NOT NULL DEFAULT 'manual',
  verified_at TEXT,
  opt_out_flag INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON company_contacts(company_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON company_contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON company_contacts(phone_e164);

CREATE TABLE IF NOT EXISTS company_product_interests (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  profile_key TEXT NOT NULL,
  buyer_type TEXT NOT NULL DEFAULT '',
  fit_score INTEGER NOT NULL DEFAULT 0,
  evidence_score INTEGER NOT NULL DEFAULT 0,
  intent_level TEXT NOT NULL DEFAULT 'unknown',
  total_score INTEGER NOT NULL DEFAULT 0,
  score_breakdown_json TEXT NOT NULL DEFAULT '{}',
  demand_note TEXT NOT NULL DEFAULT '',
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cpi_company_profile ON company_product_interests(company_id, profile_key);

-- ODbL Collective Database physical isolation: raw OSM leads stay strictly separate from verified company master
CREATE TABLE IF NOT EXISTS raw_osm_pool (
  id TEXT PRIMARY KEY,
  osm_ref TEXT NOT NULL UNIQUE,
  country_en TEXT NOT NULL,
  city TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  raw_tags_json TEXT NOT NULL DEFAULT '{}',
  collected_by TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  promoted_company_id TEXT,
  license_tag TEXT NOT NULL DEFAULT 'ODbL',
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_osm_country_city ON raw_osm_pool(country_en, city, promoted_company_id);

CREATE TABLE IF NOT EXISTS source_evidences (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  field_scope TEXT NOT NULL DEFAULT 'company',
  source_type TEXT NOT NULL CHECK(source_type IN ('website','worldbank','customs_csv','expo','manual','osm','migration')),
  source_url TEXT NOT NULL DEFAULT '',
  license_class TEXT NOT NULL DEFAULT 'independent',
  verified_by TEXT NOT NULL DEFAULT '',
  verified_at TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_ev_company ON source_evidences(company_id);

-- Append-only immutable contact timeline (idempotent by client-generated event_id)
CREATE TABLE IF NOT EXISTS contact_events (
  event_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  contact_id TEXT NOT NULL DEFAULT '',
  employee_id TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  channel TEXT NOT NULL,
  action_outcome TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  next_action TEXT NOT NULL DEFAULT '',
  next_follow_date TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_company_time ON contact_events(company_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_emp_time ON contact_events(employee_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_next_date ON contact_events(next_follow_date);

-- Server-side atomic short-term anti-duplicate lock (bound to lock_id + employee_id + session_id; NOT ownership)
CREATE TABLE IF NOT EXISTS contact_locks (
  company_id TEXT PRIMARY KEY,
  lock_id TEXT NOT NULL UNIQUE,
  employee_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'general',
  locked_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_locks_expires ON contact_locks(expires_at);

CREATE TABLE IF NOT EXISTS quote_records (
  quote_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  ref_no TEXT NOT NULL DEFAULT '',
  quote_tier TEXT NOT NULL DEFAULT 'indicative',
  profile_version INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL DEFAULT '{}',
  sent_confirmed INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT '',
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quotes_company ON quote_records(company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS compliance_order_logs (
  log_id TEXT PRIMARY KEY,
  order_ref TEXT NOT NULL DEFAULT '',
  company_id TEXT NOT NULL,
  decision TEXT NOT NULL DEFAULT 'review',
  checks_json TEXT NOT NULL DEFAULT '{}',
  reviewer TEXT NOT NULL DEFAULT '',
  saved_at TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comp_logs_company ON compliance_order_logs(company_id, saved_at DESC);

-- Team search task metadata ledger ONLY (never stores Google raw business fields)
CREATE TABLE IF NOT EXISTS scrape_task_logs (
  id TEXT PRIMARY KEY,
  country_en TEXT NOT NULL,
  city TEXT NOT NULL DEFAULT '',
  radius_km INTEGER NOT NULL DEFAULT 30,
  keyword TEXT NOT NULL DEFAULT '',
  profile_key TEXT NOT NULL DEFAULT 'all',
  engine TEXT NOT NULL DEFAULT 'osm',
  employee_id TEXT NOT NULL,
  raw_count INTEGER NOT NULL DEFAULT 0,
  verified_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scrape_country_time ON scrape_task_logs(country_en, created_at DESC);

CREATE TABLE IF NOT EXISTS product_profiles (
  profile_key TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  diff_summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs(target_type, target_id);

CREATE TABLE IF NOT EXISTS feedback_items (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  sanitized_context_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','planned','shipped','declined')),
  admin_reply TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_status_time ON feedback_items(status, created_at DESC);

CREATE TABLE IF NOT EXISTS gmaps_quota_usage (
  quota_key TEXT PRIMARY KEY,
  ym TEXT NOT NULL,
  scope TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  cap INTEGER NOT NULL DEFAULT 950,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS migration_batches (
  batch_id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_maintenance_state (
  state_key TEXT PRIMARY KEY,
  state_value TEXT NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS restore_jobs (
  job_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('in_progress','completed','failed')),
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL DEFAULT '',
  snapshot_sha256 TEXT NOT NULL DEFAULT '',
  expected_counts_json TEXT NOT NULL DEFAULT '{}',
  actual_counts_json TEXT NOT NULL DEFAULT '{}',
  preserved_protections_json TEXT NOT NULL DEFAULT '[]',
  error_message TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  finished_at TEXT,
  verified_at TEXT,
  verified_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_restore_jobs_started ON restore_jobs(started_at DESC);

