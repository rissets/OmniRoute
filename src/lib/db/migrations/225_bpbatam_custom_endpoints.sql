CREATE TABLE IF NOT EXISTS bp_custom_endpoints (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  api_key_ciphertext TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS bp_custom_models (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES bp_custom_endpoints(id) ON DELETE CASCADE,
  upstream_id TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  quota_enabled INTEGER NOT NULL DEFAULT 1 CHECK(quota_enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(endpoint_id, upstream_id)
);

CREATE INDEX IF NOT EXISTS bp_custom_models_endpoint_id ON bp_custom_models(endpoint_id);
