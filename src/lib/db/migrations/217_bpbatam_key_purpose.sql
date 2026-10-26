ALTER TABLE bp_subject_keys ADD COLUMN purpose TEXT NOT NULL DEFAULT 'api';
ALTER TABLE bp_subject_keys ADD COLUMN previous_key_id TEXT;
