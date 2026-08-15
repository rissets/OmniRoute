-- Allow independent 5h, weekly, and monthly global token limits per key.
CREATE TABLE IF NOT EXISTS api_key_token_limits_v3 (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('model', 'provider', 'global')),
  scope_value TEXT NOT NULL DEFAULT '',
  token_limit INTEGER NOT NULL CHECK (token_limit > 0),
  reset_interval TEXT NOT NULL DEFAULT 'monthly' CHECK (reset_interval IN ('5h', 'daily', 'weekly', 'monthly')),
  reset_time TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (api_key_id, scope_type, scope_value, reset_interval)
);
INSERT OR REPLACE INTO api_key_token_limits_v3 SELECT * FROM api_key_token_limits;
DROP TABLE api_key_token_limits;
ALTER TABLE api_key_token_limits_v3 RENAME TO api_key_token_limits;
CREATE INDEX IF NOT EXISTS idx_aktl_api_key_id ON api_key_token_limits (api_key_id);
