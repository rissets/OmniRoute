CREATE TABLE IF NOT EXISTS bp_topup_requests (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES bp_token_accounts(id),
 amount INTEGER NOT NULL CHECK(amount>0),
 actor TEXT NOT NULL,
 reason TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'requested',
 decided_by TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
