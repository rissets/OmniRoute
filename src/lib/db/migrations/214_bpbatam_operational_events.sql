ALTER TABLE bp_principals ADD COLUMN department_id TEXT;
ALTER TABLE bp_principals ADD COLUMN policy_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE bp_principals ADD COLUMN desired_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bp_token_admissions ADD COLUMN department_id TEXT;
ALTER TABLE bp_token_admissions ADD COLUMN policy_revision INTEGER;
CREATE TABLE IF NOT EXISTS bp_operational_metadata (id TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO bp_operational_metadata VALUES ('instance_id',lower(hex(randomblob(16))));
CREATE TABLE IF NOT EXISTS bp_operational_events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 event_id TEXT NOT NULL UNIQUE,
 kind TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER IF NOT EXISTS bp_admission_insert_event AFTER INSERT ON bp_token_admissions
BEGIN
 INSERT INTO bp_operational_events(event_id,kind,payload_json) VALUES
 (lower(hex(randomblob(16))),'request.reserved',json_object('request_id',NEW.id,'account_id',NEW.account_id,'key_id',NEW.key_id,'department_id',NEW.department_id,'policy_revision',NEW.policy_revision,'endpoint',NEW.endpoint,'model',NEW.model,'reserved',NEW.reserved,'actual',NEW.actual,'state',NEW.state,'usage',NEW.usage_json,'occurred_at',NEW.created_at));
END;
CREATE TRIGGER IF NOT EXISTS bp_admission_update_event AFTER UPDATE ON bp_token_admissions
WHEN OLD.state != NEW.state OR COALESCE(OLD.actual,-1) != COALESCE(NEW.actual,-1)
BEGIN
 INSERT INTO bp_operational_events(event_id,kind,payload_json) VALUES
 (lower(hex(randomblob(16))),'request.'||NEW.state,json_object('request_id',NEW.id,'account_id',NEW.account_id,'key_id',NEW.key_id,'department_id',NEW.department_id,'policy_revision',NEW.policy_revision,'endpoint',NEW.endpoint,'model',NEW.model,'reserved',NEW.reserved,'actual',NEW.actual,'state',NEW.state,'usage',NEW.usage_json,'occurred_at',NEW.created_at));
END;
CREATE TRIGGER IF NOT EXISTS bp_account_update_event AFTER UPDATE ON bp_token_accounts
BEGIN
 INSERT INTO bp_operational_events(event_id,kind,payload_json) VALUES
 (lower(hex(randomblob(16))),'account.updated',json_object('account_id',NEW.id,'parent_id',NEW.parent_id,'balance',NEW.balance,'reserved',NEW.reserved));
END;
CREATE TRIGGER IF NOT EXISTS bp_policy_update_event AFTER UPDATE ON bp_principals
BEGIN
 INSERT INTO bp_operational_events(event_id,kind,payload_json) VALUES
 (lower(hex(randomblob(16))),'policy.updated',json_object('subject',NEW.subject,'account_id',NEW.account_id,'department_id',NEW.department_id,'policy_revision',NEW.policy_revision,'active',NEW.active));
END;
