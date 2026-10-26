CREATE TABLE IF NOT EXISTS bp_subject_keys (
 key_id TEXT PRIMARY KEY,
 subject TEXT NOT NULL REFERENCES bp_principals(subject),
 command_id TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS bp_subject_keys_subject ON bp_subject_keys(subject);
