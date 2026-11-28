-- FriesGo Global V2.1 M2-A Schema Migration v3 (Strictly Additive)
-- Adds persistent restore_jobs ledger so backup restores track snapshot SHA-256,
-- expected/actual row reconciliation, and completion/failure status (R04/R05).

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
