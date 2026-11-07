-- Metadata only; meeting text and generated content remain outside native accounting.
ALTER TABLE bp_meeting_attempts ADD COLUMN operation_kind TEXT NOT NULL DEFAULT 'stt';
ALTER TABLE bp_meeting_attempts ADD COLUMN provenance_json TEXT NOT NULL DEFAULT '{}';
