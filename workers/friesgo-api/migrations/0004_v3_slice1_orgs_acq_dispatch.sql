-- FriesGo Global V3.0 Slice 1 Additive Schema Migration (v4)
-- Strictly additive migration delivering:
--   REV01: Logical multi-tenant isolation (orgs, org_memberships, support_access_grants, org_id on existing tables + org-scoped unique indexes)
--   ENG01/04: Strong idempotency_keys with lease recovery & anonymous applications with non-enumerable lookup_secret_hash
--   ENG03: Auth-proxied attachments_meta (zero unauthenticated presigned URLs)
--   NEW01: product_catalog_approvals (verified specs & certifications with expiry)
--   UX03/04/ENG06: projects, project_participants, inquiries, lead_assignments, assignment_events
--   ACQ01-12/REV11: discovery_tasks, demand_signals (4-tier signals, FB/IG/LI workflows, source comparison)
--   REV07/08: deal_registrations (3-tier registration, blind dedupe, protection receipt/confirmation)

CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  org_type TEXT NOT NULL CHECK(org_type IN ('company_main','independent_trial')),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','closed')),
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO orgs (id, org_type, name, status, settings_json, created_at, updated_at)
VALUES (
  'org_friesgo_main',
  'company_main',
  'FriesGo Global',
  'active',
  '{"exporterBrandName":"FriesGo Global","publicContactHint":"Official Export Desk","referralWindowDays":null,"protectionDays":null,"tailPeriodPolicy":null,"defaultAcceptHours":null,"defaultFirstContactHours":null,"defaultInquiryCap":5,"defaultDevLeadCap":15}',
  '2026-11-28T00:00:00.000Z',
  '2026-11-28T00:00:00.000Z'
);

CREATE TABLE IF NOT EXISTS org_memberships (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('super_admin','manager','staff','partner_followup','partner_referrer','independent_user')),
  can_finance_settle INTEGER NOT NULL DEFAULT 0,
  partner_ref_code TEXT,
  partner_approved_title TEXT NOT NULL DEFAULT '',
  countries_json TEXT NOT NULL DEFAULT '[]',
  languages_json TEXT NOT NULL DEFAULT '[]',
  product_lines_json TEXT NOT NULL DEFAULT '[]',
  lead_cap_inquiry INTEGER NOT NULL DEFAULT 5,
  lead_cap_dev INTEGER NOT NULL DEFAULT 15,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('pending_training','active','disabled')),
  approved_by TEXT NOT NULL DEFAULT '',
  activated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_mem_unique ON org_memberships(employee_id, org_id, role);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_mem_ref_code ON org_memberships(partner_ref_code) WHERE partner_ref_code IS NOT NULL AND partner_ref_code != '';
CREATE INDEX IF NOT EXISTS idx_org_mem_emp ON org_memberships(employee_id, status);
CREATE INDEX IF NOT EXISTS idx_org_mem_org ON org_memberships(org_id, status);

CREATE TABLE IF NOT EXISTS support_access_grants (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  granted_by_employee_id TEXT NOT NULL,
  grantee_employee_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'read_only_diagnostics',
  reason TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_support_grants_lookup ON support_access_grants(org_id, grantee_employee_id, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  org_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  target_id TEXT NOT NULL DEFAULT '',
  idem_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('in_progress','completed')),
  response_status INTEGER NOT NULL DEFAULT 0,
  response_json TEXT NOT NULL DEFAULT '{}',
  lease_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, actor_id, scope, target_id, idem_key)
);

CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  application_no TEXT NOT NULL UNIQUE,
  lookup_secret_hash TEXT NOT NULL UNIQUE,
  idem_key TEXT NOT NULL UNIQUE,
  app_type TEXT NOT NULL CHECK(app_type IN ('partner','tool_trial','team_career')),
  partner_mode TEXT NOT NULL DEFAULT '',
  applicant_name TEXT NOT NULL,
  country_tz TEXT NOT NULL DEFAULT '',
  languages TEXT NOT NULL DEFAULT '',
  contact_channel TEXT NOT NULL,
  contact_value TEXT NOT NULL,
  product_lines_json TEXT NOT NULL DEFAULT '[]',
  summary_json TEXT NOT NULL DEFAULT '{}',
  privacy_consent_at TEXT NOT NULL,
  marketing_opt_in INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','pending_review','interviewing','need_more_info','approved','rejected','training','active','closed')),
  reviewer_id TEXT NOT NULL DEFAULT '',
  review_note TEXT NOT NULL DEFAULT '',
  quiz_passed_at TEXT,
  quiz_score INTEGER NOT NULL DEFAULT 0,
  linked_employee_id TEXT NOT NULL DEFAULT '',
  linked_membership_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(app_type, status, created_at DESC);

CREATE TABLE IF NOT EXISTS product_catalog_approvals (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  category_key TEXT NOT NULL,
  title_en TEXT NOT NULL,
  title_cn TEXT NOT NULL,
  supply_status TEXT NOT NULL DEFAULT 'needs_confirmation' CHECK(supply_status IN ('direct_supply','needs_confirmation','intelligence_only')),
  approved_specs_json TEXT NOT NULL DEFAULT '{}',
  verified_certs_json TEXT NOT NULL DEFAULT '[]',
  moq_note TEXT NOT NULL DEFAULT '',
  tech_owner_name TEXT NOT NULL DEFAULT '',
  catalog_version INTEGER NOT NULL DEFAULT 1,
  approved_by TEXT NOT NULL DEFAULT '',
  approved_at TEXT,
  review_due_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prod_cat_org_key ON product_catalog_approvals(org_id, category_key);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_code TEXT NOT NULL,
  title TEXT NOT NULL,
  country_en TEXT NOT NULL DEFAULT '',
  product_line TEXT NOT NULL DEFAULT '',
  fulfillment_readiness TEXT NOT NULL DEFAULT 'needs_confirmation' CHECK(fulfillment_readiness IN ('direct_supply','needs_confirmation','intelligence_only')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','on_hold','won','lost','closed')),
  primary_owner_id TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_org_code ON projects(org_id, project_code);
CREATE INDEX IF NOT EXISTS idx_projects_org_status ON projects(org_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS project_participants (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  buyer_role TEXT NOT NULL DEFAULT 'unknown' CHECK(buyer_role IN ('owner','designer','epc','subcontractor','importer','distributor','buyer','unknown')),
  contact_name TEXT NOT NULL DEFAULT '',
  contact_channel TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proj_part_proj ON project_participants(org_id, project_id);
CREATE INDEX IF NOT EXISTS idx_proj_part_comp ON project_participants(org_id, company_id);

CREATE TABLE IF NOT EXISTS discovery_tasks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN ('facebook','instagram','linkedin','youtube','website','radar','other')),
  acquisition_mode TEXT NOT NULL CHECK(acquisition_mode IN ('manual_discovery','owned_account_inquiry','owned_ad_form','partner_referral','radar_signal','file_import')),
  title TEXT NOT NULL,
  target_buyer_roles TEXT NOT NULL DEFAULT '',
  product_keywords TEXT NOT NULL DEFAULT '',
  intent_keywords TEXT NOT NULL DEFAULT '',
  exclude_keywords TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT '',
  country_scope TEXT NOT NULL DEFAULT 'ANY',
  owner_employee_id TEXT NOT NULL DEFAULT '',
  review_window_days INTEGER NOT NULL DEFAULT 14,
  candidate_cap INTEGER NOT NULL DEFAULT 50,
  hours_logged_tenths INTEGER NOT NULL DEFAULT 0,
  actual_spend_minor INTEGER,
  spend_currency TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','completed','archived')),
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_disc_tasks_org ON discovery_tasks(org_id, platform, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS discovery_task_efforts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  hours_delta_tenths INTEGER NOT NULL DEFAULT 0,
  spend_delta_minor INTEGER,
  spend_currency TEXT NOT NULL DEFAULT '',
  entry_type TEXT NOT NULL DEFAULT 'log' CHECK(entry_type IN ('initial','log','adjustment')),
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_disc_efforts_org_occ ON discovery_task_efforts(org_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_disc_efforts_task ON discovery_task_efforts(org_id, task_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS demand_signals (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  task_id TEXT NOT NULL DEFAULT '',
  source_platform TEXT NOT NULL CHECK(source_platform IN ('facebook','instagram','linkedin','youtube','website','worldbank','gdacs','news','manual_import','other')),
  acquisition_mode TEXT NOT NULL CHECK(acquisition_mode IN ('manual_discovery','owned_account_inquiry','owned_ad_form','partner_referral','radar_signal','file_import')),
  signal_tier TEXT NOT NULL DEFAULT 'potential_demand' CHECK(signal_tier IN ('market_event','potential_demand','verified_opportunity','direct_inquiry')),
  source_url TEXT NOT NULL DEFAULT '',
  external_id TEXT NOT NULL DEFAULT '',
  published_at TEXT,
  discovered_at TEXT NOT NULL,
  last_verified_at TEXT,
  language TEXT NOT NULL DEFAULT '',
  country_en TEXT NOT NULL DEFAULT '',
  product_line TEXT NOT NULL DEFAULT '',
  fulfillment_readiness TEXT NOT NULL DEFAULT 'needs_confirmation' CHECK(fulfillment_readiness IN ('direct_supply','needs_confirmation','intelligence_only')),
  company_name TEXT NOT NULL DEFAULT '',
  buyer_role TEXT NOT NULL DEFAULT 'unknown',
  contact_name TEXT NOT NULL DEFAULT '',
  contact_channel TEXT NOT NULL DEFAULT '',
  demand_summary TEXT NOT NULL,
  usage_license_scope TEXT NOT NULL DEFAULT 'manual_review_only',
  ai_inferred_fields_json TEXT NOT NULL DEFAULT '{}',
  judgment_tags_json TEXT NOT NULL DEFAULT '{}',
  missing_info_json TEXT NOT NULL DEFAULT '[]',
  audit_status TEXT NOT NULL DEFAULT 'pending_verify' CHECK(audit_status IN ('pending_verify','verified_valid','approved','duplicate','expired','seller_ad','irrelevant','rejected')),
  audit_reason TEXT NOT NULL DEFAULT '',
  contact_result TEXT NOT NULL DEFAULT 'to_contact' CHECK(contact_result IN ('to_contact','manual_sent','waiting_reply','active_dialogue','need_specs','converted_inquiry','paused','invalid','opted_out')),
  opt_out_locked INTEGER NOT NULL DEFAULT 0,
  opt_out_at TEXT,
  idem_key TEXT NOT NULL DEFAULT '',
  draft_count INTEGER NOT NULL DEFAULT 0,
  copy_count INTEGER NOT NULL DEFAULT 0,
  manual_sent_count INTEGER NOT NULL DEFAULT 0,
  manual_sent_at TEXT,
  replied_at TEXT,
  next_action TEXT NOT NULL DEFAULT '',
  next_action_due_at TEXT,
  referrer_employee_id TEXT NOT NULL DEFAULT '',
  linked_company_id TEXT NOT NULL DEFAULT '',
  linked_project_id TEXT NOT NULL DEFAULT '',
  linked_inquiry_id TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signals_org_plat ON demand_signals(org_id, source_platform, acquisition_mode, audit_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_ext ON demand_signals(org_id, source_platform, external_id);
CREATE INDEX IF NOT EXISTS idx_signals_task ON demand_signals(org_id, task_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_org_idem ON demand_signals(org_id, created_by, idem_key) WHERE idem_key != '';

CREATE TABLE IF NOT EXISTS inquiries (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  inquiry_no TEXT NOT NULL UNIQUE,
  company_id TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '',
  source_signal_id TEXT NOT NULL DEFAULT '',
  source_platform TEXT NOT NULL DEFAULT 'website',
  acquisition_mode TEXT NOT NULL DEFAULT 'owned_account_inquiry',
  country_en TEXT NOT NULL DEFAULT '',
  product_line TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL,
  specs_json TEXT NOT NULL DEFAULT '{}',
  contact_channel TEXT NOT NULL DEFAULT '',
  contact_value TEXT NOT NULL DEFAULT '',
  referrer_employee_id TEXT NOT NULL DEFAULT '',
  primary_owner_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','need_specs','rfq_in_progress','quoted','won','paused','lost','invalid')),
  loss_reason TEXT NOT NULL DEFAULT '',
  exit_stage TEXT NOT NULL DEFAULT '',
  linked_quote_id TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inquiries_org_status ON inquiries(org_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS lead_assignments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  company_id TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '',
  inquiry_id TEXT NOT NULL DEFAULT '',
  signal_id TEXT NOT NULL DEFAULT '',
  lead_kind TEXT NOT NULL DEFAULT 'dev_lead' CHECK(lead_kind IN ('valid_inquiry','dev_lead')),
  assignment_status TEXT NOT NULL DEFAULT 'pending_dispatch' CHECK(assignment_status IN ('pending_audit','pending_dispatch','pending_accept','accepted','rejected','reassigned','reclaimed')),
  business_stage TEXT NOT NULL DEFAULT 'to_contact' CHECK(business_stage IN ('to_contact','following_up','inquired','quoted','negotiating','won','paused','invalid')),
  primary_assignee_id TEXT NOT NULL DEFAULT '',
  collaborators_json TEXT NOT NULL DEFAULT '[]',
  source_contributor_id TEXT NOT NULL DEFAULT '',
  assigned_by TEXT NOT NULL DEFAULT '',
  accept_deadline_at TEXT,
  first_contact_deadline_at TEXT,
  sla_timezone TEXT NOT NULL DEFAULT 'Asia/Singapore',
  sla_paused_reason TEXT NOT NULL DEFAULT '',
  loss_reason TEXT NOT NULL DEFAULT '',
  last_op_id TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assign_org_assignee ON lead_assignments(org_id, primary_assignee_id, assignment_status);
CREATE INDEX IF NOT EXISTS idx_assign_org_company ON lead_assignments(org_id, company_id);

CREATE TABLE IF NOT EXISTS assignment_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  op_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL CHECK(event_type IN ('created','dispatched','accepted','rejected','reassigned','reclaimed','stage_changed','sla_paused')),
  actor_id TEXT NOT NULL,
  from_assignee_id TEXT NOT NULL DEFAULT '',
  to_assignee_id TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assign_ev_assign ON assignment_events(org_id, assignment_id, created_at DESC);

CREATE TABLE IF NOT EXISTS deal_registrations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  reg_no TEXT NOT NULL UNIQUE,
  reg_tier TEXT NOT NULL CHECK(reg_tier IN ('relationship_reg','demand_reg','project_reg')),
  partner_employee_id TEXT NOT NULL,
  company_name TEXT NOT NULL,
  norm_name TEXT NOT NULL,
  country_en TEXT NOT NULL DEFAULT '',
  website_domain TEXT NOT NULL DEFAULT '',
  contact_channel TEXT NOT NULL DEFAULT '',
  relationship_note TEXT NOT NULL DEFAULT '',
  demand_evidence TEXT NOT NULL DEFAULT '',
  project_title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending_audit' CHECK(status IN ('pending_audit','need_more_info','approved_receipt','approved_protected','disputed','rejected','expired','revoked')),
  linked_company_id TEXT NOT NULL DEFAULT '',
  linked_project_id TEXT NOT NULL DEFAULT '',
  receipt_type TEXT NOT NULL DEFAULT 'intake_receipt' CHECK(receipt_type IN ('intake_receipt','protection_record')),
  protection_cert_no TEXT NOT NULL DEFAULT '',
  protection_scope_json TEXT NOT NULL DEFAULT '{}',
  protection_starts_at TEXT,
  protection_expires_at TEXT,
  canonical_sha256 TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT NOT NULL DEFAULT '',
  review_note TEXT NOT NULL DEFAULT '',
  idem_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deal_reg_org_partner ON deal_registrations(org_id, partner_employee_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_reg_org_idem ON deal_registrations(org_id, partner_employee_id, idem_key) WHERE idem_key != '';

CREATE TABLE IF NOT EXISTS attachments_meta (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'internal_only' CHECK(visibility IN ('internal_only','org_authorized')),
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL,
  content_b64 TEXT NOT NULL DEFAULT '',
  uploaded_by TEXT NOT NULL,
  expires_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attach_org_entity ON attachments_meta(org_id, entity_type, entity_id);

-- Strictly additive org_id columns on existing V2.1 tables (legacy rows default to org_friesgo_main; app SQL MUST explicitly bind auth.orgId on all new writes!)
ALTER TABLE companies ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_friesgo_main';
ALTER TABLE companies ADD COLUMN source_contributor_id TEXT NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN primary_owner_id TEXT NOT NULL DEFAULT '';
ALTER TABLE company_contacts ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_friesgo_main';
ALTER TABLE contact_events ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_friesgo_main';
ALTER TABLE quote_records ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_friesgo_main';
ALTER TABLE compliance_order_logs ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_friesgo_main';
ALTER TABLE raw_osm_pool ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_friesgo_main';
ALTER TABLE contact_locks ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_friesgo_main';

-- Replace global google_place_id unique index with org-scoped unique index (REV01: Org A and Org B must never collide or leak existence!)
DROP INDEX IF EXISTS idx_companies_place_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_org_place_id ON companies(org_id, google_place_id) WHERE google_place_id IS NOT NULL AND google_place_id != '';
CREATE INDEX IF NOT EXISTS idx_companies_org_name ON companies(org_id, norm_name, country_en);
CREATE INDEX IF NOT EXISTS idx_companies_org_domain ON companies(org_id, website_domain);
