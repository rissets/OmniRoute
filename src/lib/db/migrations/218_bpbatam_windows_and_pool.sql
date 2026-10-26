CREATE TABLE IF NOT EXISTS bp_pool_caps (account_id TEXT PRIMARY KEY REFERENCES bp_token_accounts(id), ceiling INTEGER NOT NULL CHECK(ceiling>0));
CREATE TABLE IF NOT EXISTS bp_user_quota_profiles (account_id TEXT PRIMARY KEY REFERENCES bp_token_accounts(id), revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS bp_user_windows (
 account_id TEXT NOT NULL REFERENCES bp_token_accounts(id), seconds INTEGER NOT NULL CHECK(seconds IN (18000,604800,2592000)),
 token_limit INTEGER NOT NULL CHECK(token_limit>0), anchor_ms INTEGER NOT NULL, epoch INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(account_id,seconds)
);
CREATE TABLE IF NOT EXISTS bp_user_window_admissions (
 admission_id TEXT NOT NULL REFERENCES bp_token_admissions(id), account_id TEXT NOT NULL, seconds INTEGER NOT NULL,
 epoch INTEGER NOT NULL, period INTEGER NOT NULL, PRIMARY KEY(admission_id,seconds)
);
CREATE INDEX IF NOT EXISTS bp_user_window_usage ON bp_user_window_admissions(account_id,seconds,epoch,period);
CREATE TABLE IF NOT EXISTS bp_user_window_commands (id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, result_json TEXT NOT NULL);
