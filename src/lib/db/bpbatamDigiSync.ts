import { getDbInstance } from "./core";
import { decrypt } from "./encryption";
import {
  DEFAULT_BASE_CREDIT_RUPIAH,
  DEFAULT_REF_TOKENS_PER_CREDIT,
  DEFAULT_USD_IDR_RATE,
} from "@/lib/bpbatam/creditUnits";

export interface DigiCreditSyncState {
  tenant_id: string;
  digi_account_id: string | null;
  last_balance_micro: number;
  last_reserved_micro: number;
  last_available_micro: number;
  base_credit_rupiah: number;
  usd_idr_rate: number;
  ref_tokens_per_credit: number;
  economic_revision: number;
  last_synced_at: string | null;
  last_sync_source: string | null;
  last_sync_error: string | null;
  catalog_synced_at?: string | null;
}

export interface DigiModelCreditRateCore {
  model_id: string;
  input_micro_credits_per_1m: number;
  output_micro_credits_per_1m: number;
}

export interface DigiModelCreditRateAttributes {
  cached_micro_credits_per_1m: number;
  unit_micro_credits: number;
  request_fee_micro_credits: number;
  billing_unit: string;
  display_name: string | null;
  provider: string | null;
  category: string | null;
}

export interface DigiModelCreditRate
  extends DigiModelCreditRateCore, DigiModelCreditRateAttributes {
  active: number;
  updated_at: string;
}

export interface DigiModelCreditRateUpsertInput
  extends DigiModelCreditRateCore, Partial<DigiModelCreditRateAttributes> {}

export interface DigiCatalogReconcileSummary {
  active_models: number;
  deactivated_models: number;
  active_model_ids: string[];
}

export interface ConfiguredDigiRouteTarget {
  baseUrl: string;
  apiKey: string | null;
  endpointId: string | null;
}

export interface DigiCreditGrantRecord {
  command_id: string;
  tenant_id: string;
  order_id: string;
  mode: "add" | "pull_sync" | "sync";
  credits_granted_micro: number;
  payload_hash: string;
  issued_at: string;
  applied_at: string;
}

const db = () => getDbInstance();

export function getDigiCreditSyncState(tenantId = "bpbatam"): DigiCreditSyncState {
  try {
    const row = db()
      .prepare("SELECT * FROM bp_digi_credit_sync_state WHERE tenant_id = ?")
      .get(tenantId) as DigiCreditSyncState | undefined;
    if (row) return row;
  } catch {
    // Table may not exist before migrations run in isolated test harnesses
  }
  return {
    tenant_id: tenantId,
    digi_account_id: null,
    last_balance_micro: 0,
    last_reserved_micro: 0,
    last_available_micro: 0,
    base_credit_rupiah: DEFAULT_BASE_CREDIT_RUPIAH,
    usd_idr_rate: DEFAULT_USD_IDR_RATE,
    ref_tokens_per_credit: DEFAULT_REF_TOKENS_PER_CREDIT,
    economic_revision: 1,
    last_synced_at: null,
    last_sync_source: null,
    last_sync_error: null,
    catalog_synced_at: null,
  };
}

export function upsertDigiCreditSyncState(
  tenantId: string,
  patch: Partial<Omit<DigiCreditSyncState, "tenant_id">>
): DigiCreditSyncState {
  const current = getDigiCreditSyncState(tenantId);
  const next: DigiCreditSyncState = {
    tenant_id: tenantId,
    digi_account_id:
      patch.digi_account_id !== undefined ? patch.digi_account_id : current.digi_account_id,
    last_balance_micro: patch.last_balance_micro ?? current.last_balance_micro,
    last_reserved_micro: patch.last_reserved_micro ?? current.last_reserved_micro,
    last_available_micro: patch.last_available_micro ?? current.last_available_micro,
    base_credit_rupiah: patch.base_credit_rupiah ?? current.base_credit_rupiah,
    usd_idr_rate: patch.usd_idr_rate ?? current.usd_idr_rate,
    ref_tokens_per_credit: patch.ref_tokens_per_credit ?? current.ref_tokens_per_credit,
    economic_revision: patch.economic_revision ?? current.economic_revision,
    last_synced_at:
      patch.last_synced_at !== undefined ? patch.last_synced_at : current.last_synced_at,
    last_sync_source:
      patch.last_sync_source !== undefined ? patch.last_sync_source : current.last_sync_source,
    last_sync_error:
      patch.last_sync_error !== undefined ? patch.last_sync_error : current.last_sync_error,
    catalog_synced_at:
      patch.catalog_synced_at !== undefined
        ? patch.catalog_synced_at
        : (current.catalog_synced_at ?? null),
  };
  db()
    .prepare(
      `INSERT INTO bp_digi_credit_sync_state(
        tenant_id, digi_account_id, last_balance_micro, last_reserved_micro, last_available_micro,
        base_credit_rupiah, usd_idr_rate, ref_tokens_per_credit, economic_revision,
        last_synced_at, last_sync_source, last_sync_error, catalog_synced_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id) DO UPDATE SET
        digi_account_id = excluded.digi_account_id,
        last_balance_micro = excluded.last_balance_micro,
        last_reserved_micro = excluded.last_reserved_micro,
        last_available_micro = excluded.last_available_micro,
        base_credit_rupiah = excluded.base_credit_rupiah,
        usd_idr_rate = excluded.usd_idr_rate,
        ref_tokens_per_credit = excluded.ref_tokens_per_credit,
        economic_revision = excluded.economic_revision,
        last_synced_at = excluded.last_synced_at,
        last_sync_source = excluded.last_sync_source,
        last_sync_error = excluded.last_sync_error,
        catalog_synced_at = excluded.catalog_synced_at`
    )
    .run(
      next.tenant_id,
      next.digi_account_id,
      next.last_balance_micro,
      next.last_reserved_micro,
      next.last_available_micro,
      next.base_credit_rupiah,
      next.usd_idr_rate,
      next.ref_tokens_per_credit,
      next.economic_revision,
      next.last_synced_at,
      next.last_sync_source,
      next.last_sync_error,
      next.catalog_synced_at ?? null
    );
  return getDigiCreditSyncState(tenantId);
}

export function upsertDigiModelCreditRates(rates: DigiModelCreditRateUpsertInput[]): void {
  if (!rates.length) return;
  const now = new Date().toISOString();
  const stmt = db().prepare(
    `INSERT INTO bp_digi_model_credit_rates(
      model_id, input_micro_credits_per_1m, cached_micro_credits_per_1m,
      output_micro_credits_per_1m, unit_micro_credits, request_fee_micro_credits,
      billing_unit, active, display_name, provider, category, updated_at
    ) VALUES(?,?,?,?,?,?,?,1,?,?,?,?)
    ON CONFLICT(model_id) DO UPDATE SET
      input_micro_credits_per_1m = excluded.input_micro_credits_per_1m,
      cached_micro_credits_per_1m = excluded.cached_micro_credits_per_1m,
      output_micro_credits_per_1m = excluded.output_micro_credits_per_1m,
      unit_micro_credits = excluded.unit_micro_credits,
      request_fee_micro_credits = excluded.request_fee_micro_credits,
      billing_unit = excluded.billing_unit,
      active = 1,
      display_name = COALESCE(excluded.display_name, bp_digi_model_credit_rates.display_name),
      provider = COALESCE(excluded.provider, bp_digi_model_credit_rates.provider),
      category = COALESCE(excluded.category, bp_digi_model_credit_rates.category),
      updated_at = excluded.updated_at`
  );
  for (const r of rates) {
    stmt.run(
      r.model_id,
      Math.max(0, Math.trunc(r.input_micro_credits_per_1m)),
      Math.max(0, Math.trunc(r.cached_micro_credits_per_1m ?? 0)),
      Math.max(0, Math.trunc(r.output_micro_credits_per_1m)),
      Math.max(0, Math.trunc(r.unit_micro_credits ?? 0)),
      Math.max(0, Math.trunc(r.request_fee_micro_credits ?? 0)),
      r.billing_unit ?? "tokens_1m",
      r.display_name ?? null,
      r.provider ?? null,
      r.category ?? null,
      now
    );
  }
}

export function reconcileDigiModelCreditRates(
  rates: DigiModelCreditRateUpsertInput[]
): DigiCatalogReconcileSummary {
  const now = new Date().toISOString();
  const deduped = new Map<string, DigiModelCreditRateUpsertInput>();
  for (const r of rates) {
    const id = r.model_id?.trim();
    if (!id) continue;
    deduped.set(id, { ...r, model_id: id });
  }
  const activeList = Array.from(deduped.values());
  if (activeList.length > 0) {
    upsertDigiModelCreditRates(activeList);
  }

  const existingActive = db()
    .prepare("SELECT model_id FROM bp_digi_model_credit_rates WHERE active = 1")
    .all() as Array<{ model_id: string }>;

  let deactivated = 0;
  const deactivateStmt = db().prepare(
    "UPDATE bp_digi_model_credit_rates SET active = 0, updated_at = ? WHERE model_id = ?"
  );
  for (const row of existingActive) {
    if (!deduped.has(row.model_id)) {
      deactivateStmt.run(now, row.model_id);
      deactivated++;
    }
  }

  const activeModelIds = Array.from(deduped.keys()).sort();
  return {
    active_models: activeModelIds.length,
    deactivated_models: deactivated,
    active_model_ids: activeModelIds,
  };
}

export function getDigiModelCreditRate(modelId: string): DigiModelCreditRate | undefined {
  if (!modelId) return undefined;
  try {
    const direct = db()
      .prepare("SELECT * FROM bp_digi_model_credit_rates WHERE model_id = ? AND active = 1")
      .get(modelId) as DigiModelCreditRate | undefined;
    if (direct) return direct;

    // Strip provider prefix (e.g., "digi-oai/gpt-6.1-terra" -> "gpt-6.1-terra")
    const slashIdx = modelId.indexOf("/");
    if (slashIdx > 0 && slashIdx < modelId.length - 1) {
      const stripped = modelId.slice(slashIdx + 1);
      const bySuffix = db()
        .prepare("SELECT * FROM bp_digi_model_credit_rates WHERE model_id = ? AND active = 1")
        .get(stripped) as DigiModelCreditRate | undefined;
      if (bySuffix) return bySuffix;
    }

    // Check if modelId is a managed custom model id (ce_.../upstream_id)
    const custom = db()
      .prepare("SELECT upstream_id FROM bp_custom_models WHERE id = ? LIMIT 1")
      .get(modelId) as { upstream_id: string } | undefined;
    if (custom?.upstream_id) {
      const byUpstream = db()
        .prepare("SELECT * FROM bp_digi_model_credit_rates WHERE model_id = ? AND active = 1")
        .get(custom.upstream_id) as DigiModelCreditRate | undefined;
      if (byUpstream) return byUpstream;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function listDigiModelCreditRates(options?: {
  includeInactive?: boolean;
}): DigiModelCreditRate[] {
  try {
    if (options?.includeInactive) {
      return db()
        .prepare("SELECT * FROM bp_digi_model_credit_rates ORDER BY model_id ASC")
        .all() as DigiModelCreditRate[];
    }
    return db()
      .prepare("SELECT * FROM bp_digi_model_credit_rates WHERE active = 1 ORDER BY model_id ASC")
      .all() as DigiModelCreditRate[];
  } catch {
    return [];
  }
}

export function hasSyncedDigiCatalog(): boolean {
  try {
    const rateCount = db().prepare("SELECT COUNT(*) AS n FROM bp_digi_model_credit_rates").get() as
      { n: number } | undefined;
    if (rateCount && rateCount.n > 0) return true;

    const syncedState = db()
      .prepare(
        "SELECT 1 AS ok FROM bp_digi_credit_sync_state WHERE catalog_synced_at IS NOT NULL LIMIT 1"
      )
      .get() as { ok: number } | undefined;
    return Boolean(syncedState?.ok);
  } catch {
    return false;
  }
}

export function getActiveDigiModelIds(): Set<string> {
  try {
    const rows = db()
      .prepare("SELECT model_id FROM bp_digi_model_credit_rates WHERE active = 1")
      .all() as Array<{ model_id: string }>;
    return new Set(rows.map((r) => r.model_id));
  } catch {
    return new Set<string>();
  }
}

export function isDigiModelActive(modelId: string, activeIds?: Set<string>): boolean {
  if (!modelId) return false;
  const set = activeIds ?? getActiveDigiModelIds();
  if (set.has(modelId)) return true;

  const normalized = modelId.startsWith("combo/") ? modelId.slice("combo/".length) : modelId;
  if (set.has(normalized)) return true;

  const slashIdx = normalized.indexOf("/");
  if (slashIdx > 0 && slashIdx < normalized.length - 1) {
    if (set.has(normalized.slice(slashIdx + 1))) return true;
  }

  try {
    const custom = db()
      .prepare("SELECT upstream_id FROM bp_custom_models WHERE id = ? LIMIT 1")
      .get(normalized) as { upstream_id: string } | undefined;
    if (custom?.upstream_id && set.has(custom.upstream_id)) return true;
  } catch {
    // ignore
  }
  return false;
}

export function getDigiCreditGrant(commandId: string): DigiCreditGrantRecord | undefined {
  return db().prepare("SELECT * FROM bp_digi_credit_grants WHERE command_id = ?").get(commandId) as
    DigiCreditGrantRecord | undefined;
}

export function insertDigiCreditGrant(record: Omit<DigiCreditGrantRecord, "applied_at">): void {
  db()
    .prepare(
      `INSERT INTO bp_digi_credit_grants(
        command_id, tenant_id, order_id, mode, credits_granted_micro, payload_hash, issued_at
      ) VALUES(?,?,?,?,?,?,?)`
    )
    .run(
      record.command_id,
      record.tenant_id,
      record.order_id,
      record.mode,
      record.credits_granted_micro,
      record.payload_hash,
      record.issued_at
    );
}

export function listConfiguredDigiRouteTargets(): ConfiguredDigiRouteTarget[] {
  const targets: ConfiguredDigiRouteTarget[] = [];
  try {
    const customRows = db()
      .prepare(
        "SELECT id, base_url, api_key_ciphertext FROM bp_custom_endpoints WHERE enabled = 1 ORDER BY created_at ASC"
      )
      .all() as Array<{ id: string; base_url: string; api_key_ciphertext: string | null }>;
    for (const r of customRows) {
      if (!r.base_url) continue;
      const decrypted = r.api_key_ciphertext
        ? (decrypt(r.api_key_ciphertext, { quiet: true }) ?? null)
        : null;
      targets.push({
        baseUrl: r.base_url,
        apiKey: decrypted?.trim() || null,
        endpointId: r.id,
      });
    }
  } catch {
    // ignore
  }
  try {
    const nodeRows = db()
      .prepare(
        `SELECT n.id, n.base_url, c.api_key
         FROM provider_nodes n
         LEFT JOIN provider_connections c
           ON c.provider = n.id AND c.is_active = 1
         WHERE n.type IN ('openai-compatible', 'anthropic-compatible')
           AND n.base_url IS NOT NULL AND n.base_url != ''
         ORDER BY n.created_at ASC`
      )
      .all() as Array<{ id: string; base_url: string; api_key: string | null }>;
    for (const r of nodeRows) {
      if (!r.base_url) continue;
      const decrypted = r.api_key ? (decrypt(r.api_key, { quiet: true }) ?? null) : null;
      targets.push({
        baseUrl: r.base_url,
        apiKey: decrypted?.trim() || null,
        endpointId: r.id,
      });
    }
  } catch {
    // ignore
  }
  return targets;
}

export function listConfiguredDigiRouteUrls(): string[] {
  return listConfiguredDigiRouteTargets().map((t) => t.baseUrl);
}
