-- FriesGo Global V2.1 M2-A Schema Migration v2 (Strictly Additive)
-- Adds persistent maintenance/restore freeze gate table (D05) and TOTP login replay tracking column (S08).

CREATE TABLE IF NOT EXISTS system_maintenance_state (
  state_key TEXT PRIMARY KEY,
  state_value TEXT NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

ALTER TABLE employees ADD COLUMN last_totp_step INTEGER NOT NULL DEFAULT 0;
