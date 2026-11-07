-- Trusted meeting purpose is persisted alongside the native admission, never accepted from /v1 headers.
CREATE TABLE IF NOT EXISTS bp_meeting_attempts (
  attempt_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  receipt_id TEXT NOT NULL UNIQUE REFERENCES bp_token_admissions(id),
  policy_revision TEXT NOT NULL
);
