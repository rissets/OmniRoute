CREATE TABLE IF NOT EXISTS bp_token_accounts (
 id TEXT PRIMARY KEY,
 parent_id TEXT REFERENCES bp_token_accounts(id),
 kind TEXT NOT NULL CHECK(kind IN ('platform','department','user')),
 balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
 reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved >= 0 AND reserved <= balance)
);
CREATE TABLE IF NOT EXISTS bp_token_commands (
 id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, actor TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS bp_token_postings (
 id TEXT PRIMARY KEY, command_id TEXT NOT NULL, account_id TEXT NOT NULL,
 delta INTEGER NOT NULL, kind TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bp_principals (
 subject TEXT PRIMARY KEY, issuer TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES bp_token_accounts(id),
 key_id TEXT NOT NULL UNIQUE, offers_json TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS bp_token_admissions (
 id TEXT PRIMARY KEY, key_id TEXT NOT NULL, account_id TEXT REFERENCES bp_token_accounts(id),
 reserved INTEGER NOT NULL CHECK(reserved > 0), actual INTEGER, state TEXT NOT NULL,
 endpoint TEXT NOT NULL, model TEXT NOT NULL, usage_json TEXT, limits_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS bp_admission_key_state ON bp_token_admissions(key_id,state);
CREATE INDEX IF NOT EXISTS bp_admission_account ON bp_token_admissions(account_id,created_at);
