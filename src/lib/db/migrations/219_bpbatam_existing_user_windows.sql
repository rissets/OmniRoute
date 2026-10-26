-- Give already-bound principals the same defaults as newly provisioned users.
-- INSERT OR IGNORE preserves operator-set limits and existing window anchors.
INSERT OR IGNORE INTO bp_user_quota_profiles(account_id)
SELECT DISTINCT account_id FROM bp_principals;
INSERT OR IGNORE INTO bp_user_windows(account_id,seconds,token_limit,anchor_ms)
SELECT DISTINCT account_id,18000,1000000,CAST(strftime('%s','now') AS INTEGER)*1000 FROM bp_principals;
INSERT OR IGNORE INTO bp_user_windows(account_id,seconds,token_limit,anchor_ms)
SELECT DISTINCT account_id,604800,10000000,CAST(strftime('%s','now') AS INTEGER)*1000 FROM bp_principals;
INSERT OR IGNORE INTO bp_user_windows(account_id,seconds,token_limit,anchor_ms)
SELECT DISTINCT account_id,2592000,30000000,CAST(strftime('%s','now') AS INTEGER)*1000 FROM bp_principals;
