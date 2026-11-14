CREATE TABLE IF NOT EXISTS bp_quota_defaults (
  seconds INTEGER PRIMARY KEY CHECK(seconds IN (18000, 604800, 2592000)),
  token_limit INTEGER NOT NULL CHECK(token_limit > 0)
);

CREATE TABLE IF NOT EXISTS bp_quota_defaults_meta (
  key TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bp_quota_defaults_schedules (
  id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL,
  effective_at_ms INTEGER NOT NULL,
  effective_at_iso TEXT NOT NULL,
  limits_json TEXT NOT NULL,
  accounts_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'applied')),
  created_at_ms INTEGER NOT NULL,
  applied_at_ms INTEGER
);

CREATE INDEX IF NOT EXISTS bp_quota_defaults_schedules_pending
  ON bp_quota_defaults_schedules(status, effective_at_ms);

CREATE TABLE IF NOT EXISTS bp_quota_defaults_commands (
  id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL
);

INSERT OR IGNORE INTO bp_quota_defaults(seconds, token_limit) VALUES
  (18000, 1000000),
  (604800, 10000000),
  (2592000, 30000000);

INSERT OR IGNORE INTO bp_quota_defaults_meta(key, revision) VALUES ('global', 0);
