ALTER TABLE bp_digi_model_credit_rates ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1));
ALTER TABLE bp_digi_model_credit_rates ADD COLUMN display_name TEXT;
ALTER TABLE bp_digi_model_credit_rates ADD COLUMN provider TEXT;
ALTER TABLE bp_digi_model_credit_rates ADD COLUMN category TEXT;

ALTER TABLE bp_digi_credit_sync_state ADD COLUMN catalog_synced_at TEXT;

CREATE INDEX IF NOT EXISTS idx_bp_digi_model_credit_rates_active
  ON bp_digi_model_credit_rates(active, model_id);
