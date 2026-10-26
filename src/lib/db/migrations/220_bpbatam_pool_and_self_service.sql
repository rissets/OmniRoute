CREATE TABLE IF NOT EXISTS bp_pool_commands (
  id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
ALTER TABLE bp_subject_keys ADD COLUMN follow_parent INTEGER NOT NULL DEFAULT 0 CHECK(follow_parent IN (0,1));
