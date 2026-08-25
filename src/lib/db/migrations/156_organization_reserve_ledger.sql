-- Organization reserve ledger for BP Batam token sharing and reset grants.
-- The monthly global token limit on the organization management key remains
-- the source total; these tables only persist the commitment breakdown.
CREATE TABLE IF NOT EXISTS organization_reserve_periods (
  api_key_id TEXT NOT NULL,
  period TEXT NOT NULL,
  base_user_tokens INTEGER NOT NULL DEFAULT 0,
  shared_allocated_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (api_key_id, period)
);

CREATE TABLE IF NOT EXISTS organization_reserve_reset_debits (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL,
  period TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  tokens INTEGER NOT NULL CHECK (tokens > 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_org_reserve_reset_key_period
  ON organization_reserve_reset_debits (api_key_id, period);

