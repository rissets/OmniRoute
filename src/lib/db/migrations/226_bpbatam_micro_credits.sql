CREATE TABLE IF NOT EXISTS bp_digi_credit_sync_state (
  tenant_id TEXT PRIMARY KEY DEFAULT 'bpbatam',
  digi_account_id TEXT,
  last_balance_micro INTEGER NOT NULL DEFAULT 0,
  last_reserved_micro INTEGER NOT NULL DEFAULT 0,
  last_available_micro INTEGER NOT NULL DEFAULT 0,
  base_credit_rupiah INTEGER NOT NULL DEFAULT 5000,
  usd_idr_rate REAL NOT NULL DEFAULT 18255,
  ref_tokens_per_credit INTEGER NOT NULL DEFAULT 152200,
  economic_revision INTEGER NOT NULL DEFAULT 1,
  last_synced_at TEXT,
  last_sync_source TEXT,
  last_sync_error TEXT
);

CREATE TABLE IF NOT EXISTS bp_digi_model_credit_rates (
  model_id TEXT PRIMARY KEY,
  input_micro_credits_per_1m INTEGER NOT NULL DEFAULT 0,
  cached_micro_credits_per_1m INTEGER NOT NULL DEFAULT 0,
  output_micro_credits_per_1m INTEGER NOT NULL DEFAULT 0,
  unit_micro_credits INTEGER NOT NULL DEFAULT 0,
  request_fee_micro_credits INTEGER NOT NULL DEFAULT 0,
  billing_unit TEXT NOT NULL DEFAULT 'tokens_1m',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS bp_digi_credit_grants (
  command_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  order_id TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL CHECK(mode IN ('add', 'pull_sync', 'sync')),
  credits_granted_micro INTEGER NOT NULL CHECK(credits_granted_micro >= 0),
  payload_hash TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

ALTER TABLE bp_token_admissions ADD COLUMN unit TEXT NOT NULL DEFAULT 'micro_credits';
ALTER TABLE bp_token_admissions ADD COLUMN raw_tokens_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE bp_token_admissions ADD COLUMN digi_receipt_id TEXT;
ALTER TABLE bp_token_admissions ADD COLUMN reconcile_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bp_token_admissions ADD COLUMN last_reconcile_at TEXT;
ALTER TABLE bp_token_admissions ADD COLUMN last_reconcile_error TEXT;

CREATE INDEX IF NOT EXISTS idx_bp_token_admissions_uncertain_reconcile
  ON bp_token_admissions(state, created_at);
