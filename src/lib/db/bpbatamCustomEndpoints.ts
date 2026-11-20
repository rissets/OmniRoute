import { randomUUID } from "node:crypto";
import { getDbInstance } from "./core";
import { encrypt, decrypt } from "./encryption";
import { validateCustomEndpointUrl } from "../bpbatam/customTransport";
import { invalidateDbCache, invalidateModelCatalogCache } from "./readCache";
import { resetProviderNodePrefixCache } from "./providers/nodePrefix";
import { getActiveDigiModelIds, hasSyncedDigiCatalog } from "./bpbatamDigiSync";

export interface CustomModelDto {
  id: string;
  upstream_id: string;
  name: string;
  enabled: boolean;
  quota_enabled: boolean;
}

export interface CustomEndpointDto {
  id: string;
  name: string;
  base_url: string;
  enabled: boolean;
  key_configured: boolean;
  models: CustomModelDto[];
}

export interface CustomEndpointRow {
  id: string;
  name: string;
  base_url: string;
  enabled: number;
  api_key_ciphertext: string | null;
  created_at: string;
  updated_at: string;
}

export interface CustomModelRow {
  id: string;
  endpoint_id: string;
  upstream_id: string;
  name: string;
  enabled: number;
  quota_enabled: number;
  created_at: string;
  updated_at: string;
}

function syncProviderNodeAndConnection(endpointId: string) {
  const endpoint = getDbInstance()
    .prepare("SELECT * FROM bp_custom_endpoints WHERE id = ?")
    .get(endpointId) as CustomEndpointRow | undefined;

  if (!endpoint) return;

  const now = new Date().toISOString();
  const existingNode = getDbInstance()
    .prepare("SELECT id FROM provider_nodes WHERE id = ?")
    .get(endpoint.id);

  if (existingNode) {
    getDbInstance()
      .prepare(
        `UPDATE provider_nodes
         SET name = ?, prefix = ?, base_url = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(endpoint.name, endpoint.id, endpoint.base_url, now, endpoint.id);
  } else {
    getDbInstance()
      .prepare(
        `INSERT INTO provider_nodes
         (id, type, name, prefix, api_type, base_url, created_at, updated_at)
         VALUES (?, 'openai-compatible', ?, ?, 'openai-compatible', ?, ?, ?)`
      )
      .run(endpoint.id, endpoint.name, endpoint.id, endpoint.base_url, now, now);
  }

  const connId = "conn_" + endpoint.id;
  const existingConn = getDbInstance()
    .prepare("SELECT id FROM provider_connections WHERE id = ?")
    .get(connId);

  const psData = JSON.stringify({ baseUrl: endpoint.base_url, isCustomEndpoint: true });

  if (existingConn) {
    getDbInstance()
      .prepare(
        `UPDATE provider_connections
         SET name = ?, api_key = ?, is_active = ?, provider_specific_data = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        endpoint.name,
        endpoint.api_key_ciphertext,
        endpoint.enabled ? 1 : 0,
        psData,
        now,
        connId
      );
  } else {
    getDbInstance()
      .prepare(
        `INSERT INTO provider_connections
         (id, provider, auth_type, name, api_key, is_active, provider_specific_data, created_at, updated_at)
         VALUES (?, ?, 'api_key', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        connId,
        endpoint.id,
        endpoint.name,
        endpoint.api_key_ciphertext,
        endpoint.enabled ? 1 : 0,
        psData,
        now,
        now
      );
  }

  syncModelsToCustomModels(endpoint.id);
  invalidateDbCache("nodes");
  invalidateDbCache("connections");
  invalidateModelCatalogCache();
  resetProviderNodePrefixCache();
}

function syncModelsToCustomModels(endpointId: string) {
  const models = getDbInstance()
    .prepare("SELECT * FROM bp_custom_models WHERE endpoint_id = ?")
    .all(endpointId) as CustomModelRow[];

  const modelsList = models.map((m) => ({
    id: m.upstream_id,
    name: m.name,
    source: "manual",
    apiFormat: "chat-completions",
    supportedEndpoints: ["chat"],
    quotaEnabled: Boolean(m.quota_enabled),
    enabled: Boolean(m.enabled),
    isHidden: !Boolean(m.enabled),
  }));

  getDbInstance()
    .prepare(
      `INSERT INTO key_value (namespace, key, value)
       VALUES ('customModels', ?, ?)
       ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value`
    )
    .run(endpointId, JSON.stringify(modelsList));

  const now = new Date().toISOString();
  for (const m of models) {
    const comboName = "combo/" + m.id;
    const comboId = "combo_" + m.id.replace(/[^a-zA-Z0-9_-]/g, "_");
    const comboData = JSON.stringify({
      id: comboId,
      name: comboName,
      strategy: "priority",
      models: [m.id],
      config: {},
      createdAt: now,
      updatedAt: now,
    });
    const existing = getDbInstance().prepare("SELECT id FROM combos WHERE name = ?").get(comboName);
    if (existing) {
      getDbInstance()
        .prepare("UPDATE combos SET data = ?, updated_at = ? WHERE name = ?")
        .run(comboData, now, comboName);
    } else {
      getDbInstance()
        .prepare(
          `INSERT INTO combos (id, name, data, sort_order, created_at, updated_at, context_cache_protection)
           VALUES (?, ?, ?, 0, ?, ?, 0)`
        )
        .run(comboId, comboName, comboData, now, now);
    }
  }

  invalidateDbCache("combos");
  invalidateModelCatalogCache();
}

export function getCustomEndpoints(): CustomEndpointDto[] {
  const endpoints = getDbInstance()
    .prepare("SELECT * FROM bp_custom_endpoints ORDER BY created_at ASC")
    .all() as CustomEndpointRow[];

  const allModels = getDbInstance()
    .prepare("SELECT * FROM bp_custom_models ORDER BY created_at ASC")
    .all() as CustomModelRow[];

  const modelsByEndpoint = new Map<string, CustomModelDto[]>();
  for (const m of allModels) {
    const list = modelsByEndpoint.get(m.endpoint_id) ?? [];
    list.push({
      id: m.id,
      upstream_id: m.upstream_id,
      name: m.name,
      enabled: Boolean(m.enabled),
      quota_enabled: Boolean(m.quota_enabled),
    });
    modelsByEndpoint.set(m.endpoint_id, list);
  }

  return endpoints.map((e) => ({
    id: e.id,
    name: e.name,
    base_url: e.base_url,
    enabled: Boolean(e.enabled),
    key_configured: Boolean(e.api_key_ciphertext && e.api_key_ciphertext.length > 0),
    models: modelsByEndpoint.get(e.id) ?? [],
  }));
}

export function getCustomEndpoint(id: string): CustomEndpointDto | null {
  const endpoint = getDbInstance()
    .prepare("SELECT * FROM bp_custom_endpoints WHERE id = ?")
    .get(id) as CustomEndpointRow | undefined;

  if (!endpoint) return null;

  const models = getDbInstance()
    .prepare("SELECT * FROM bp_custom_models WHERE endpoint_id = ? ORDER BY created_at ASC")
    .all(id) as CustomModelRow[];

  return {
    id: endpoint.id,
    name: endpoint.name,
    base_url: endpoint.base_url,
    enabled: Boolean(endpoint.enabled),
    key_configured: Boolean(endpoint.api_key_ciphertext && endpoint.api_key_ciphertext.length > 0),
    models: models.map((m) => ({
      id: m.id,
      upstream_id: m.upstream_id,
      name: m.name,
      enabled: Boolean(m.enabled),
      quota_enabled: Boolean(m.quota_enabled),
    })),
  };
}

export function createCustomEndpoint(input: {
  name: string;
  base_url: string;
  enabled?: boolean;
  api_key?: string | null;
}): CustomEndpointDto {
  const validatedUrl = validateCustomEndpointUrl(input.base_url);
  const normalizedBaseUrl = validatedUrl.origin + validatedUrl.pathname.replace(/\/+$/, "");

  const id = "ce_" + randomUUID().replace(/-/g, "").slice(0, 16);
  const now = new Date().toISOString();
  const enabledInt = input.enabled !== false ? 1 : 0;
  const trimmedKey = typeof input.api_key === "string" ? input.api_key.trim() : null;
  const ciphertext = trimmedKey ? (encrypt(trimmedKey) ?? null) : null;

  getDbInstance()
    .prepare(
      `INSERT INTO bp_custom_endpoints
       (id, name, base_url, enabled, api_key_ciphertext, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, input.name.trim(), normalizedBaseUrl, enabledInt, ciphertext, now, now);

  syncProviderNodeAndConnection(id);
  return getCustomEndpoint(id)!;
}

export function updateCustomEndpoint(
  id: string,
  input: {
    name?: string;
    base_url?: string;
    enabled?: boolean;
    api_key?: string | null;
  }
): CustomEndpointDto | null {
  const existing = getDbInstance()
    .prepare("SELECT * FROM bp_custom_endpoints WHERE id = ?")
    .get(id) as CustomEndpointRow | undefined;

  if (!existing) return null;

  let normalizedBaseUrl = existing.base_url;
  if (input.base_url !== undefined) {
    const validatedUrl = validateCustomEndpointUrl(input.base_url);
    normalizedBaseUrl = validatedUrl.origin + validatedUrl.pathname.replace(/\/+$/, "");
  }

  const name = input.name !== undefined ? input.name.trim() : existing.name;
  const enabledInt = input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled;

  let ciphertext = existing.api_key_ciphertext;
  if (input.api_key !== undefined) {
    if (input.api_key === null || input.api_key.trim() === "") {
      ciphertext = null;
    } else {
      ciphertext = encrypt(input.api_key.trim()) ?? null;
    }
  }

  const now = new Date().toISOString();
  getDbInstance()
    .prepare(
      `UPDATE bp_custom_endpoints
       SET name = ?, base_url = ?, enabled = ?, api_key_ciphertext = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(name, normalizedBaseUrl, enabledInt, ciphertext, now, id);

  syncProviderNodeAndConnection(id);
  return getCustomEndpoint(id)!;
}

export function deleteCustomEndpoint(id: string): boolean {
  const existing = getDbInstance()
    .prepare("SELECT id FROM bp_custom_endpoints WHERE id = ?")
    .get(id);

  if (!existing) return false;

  getDbInstance().prepare("DELETE FROM bp_custom_models WHERE endpoint_id = ?").run(id);
  getDbInstance().prepare("DELETE FROM bp_custom_endpoints WHERE id = ?").run(id);

  getDbInstance().prepare("DELETE FROM provider_connections WHERE provider = ?").run(id);
  getDbInstance().prepare("DELETE FROM provider_nodes WHERE id = ?").run(id);
  getDbInstance()
    .prepare("DELETE FROM key_value WHERE namespace = 'customModels' AND key = ?")
    .run(id);
  getDbInstance()
    .prepare("DELETE FROM combos WHERE name LIKE ?")
    .run("combo/" + id + "/%");
  invalidateDbCache("combos");
  invalidateDbCache("nodes");
  invalidateDbCache("connections");
  invalidateModelCatalogCache();
  resetProviderNodePrefixCache();

  return true;
}

export function createCustomEndpointModel(
  endpointId: string,
  input: {
    upstream_id: string;
    name: string;
    enabled?: boolean;
    quota_enabled?: boolean;
  }
): CustomModelDto {
  const endpoint = getDbInstance()
    .prepare("SELECT id FROM bp_custom_endpoints WHERE id = ?")
    .get(endpointId);

  if (!endpoint) {
    throw new Error("ENDPOINT_NOT_FOUND");
  }

  const upstreamId = input.upstream_id.trim();
  const existingModel = getDbInstance()
    .prepare("SELECT id FROM bp_custom_models WHERE endpoint_id = ? AND upstream_id = ?")
    .get(endpointId, upstreamId);

  if (existingModel) {
    throw new Error("MODEL_ALREADY_EXISTS");
  }

  const modelId = `${endpointId}/${upstreamId}`;
  const now = new Date().toISOString();
  const enabledInt = input.enabled !== false ? 1 : 0;
  const quotaEnabledInt = input.quota_enabled !== false ? 1 : 0;

  getDbInstance()
    .prepare(
      `INSERT INTO bp_custom_models
       (id, endpoint_id, upstream_id, name, enabled, quota_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(modelId, endpointId, upstreamId, input.name.trim(), enabledInt, quotaEnabledInt, now, now);

  syncModelsToCustomModels(endpointId);
  return {
    id: modelId,
    upstream_id: upstreamId,
    name: input.name.trim(),
    enabled: enabledInt === 1,
    quota_enabled: quotaEnabledInt === 1,
  };
}

export function updateCustomEndpointModel(
  endpointId: string,
  modelIdOrUpstreamId: string,
  input: {
    upstream_id?: string;
    name?: string;
    enabled?: boolean;
    quota_enabled?: boolean;
  }
): CustomModelDto | null {
  const raw = decodeURIComponent(modelIdOrUpstreamId).trim();
  const stripped = raw.startsWith(`${endpointId}/`) ? raw.slice(endpointId.length + 1) : raw;
  const existing = getDbInstance()
    .prepare(
      `SELECT * FROM bp_custom_models
       WHERE endpoint_id = ? AND (id = ? OR upstream_id = ? OR id = ? OR upstream_id = ?)`
    )
    .get(endpointId, raw, raw, `${endpointId}/${raw}`, stripped) as CustomModelRow | undefined;
  if (!existing) return null;

  let upstreamId = existing.upstream_id;
  let modelId = existing.id;

  if (input.upstream_id !== undefined && input.upstream_id.trim() !== existing.upstream_id) {
    upstreamId = input.upstream_id.trim();
    const collision = getDbInstance()
      .prepare(
        "SELECT id FROM bp_custom_models WHERE endpoint_id = ? AND upstream_id = ? AND id != ?"
      )
      .get(endpointId, upstreamId, existing.id);
    if (collision) {
      throw new Error("MODEL_ALREADY_EXISTS");
    }
    modelId = `${endpointId}/${upstreamId}`;
  }

  const name = input.name !== undefined ? input.name.trim() : existing.name;
  const enabledInt = input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled;
  const quotaEnabledInt =
    input.quota_enabled !== undefined ? (input.quota_enabled ? 1 : 0) : existing.quota_enabled;
  const now = new Date().toISOString();

  getDbInstance()
    .prepare(
      `UPDATE bp_custom_models
       SET id = ?, upstream_id = ?, name = ?, enabled = ?, quota_enabled = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(modelId, upstreamId, name, enabledInt, quotaEnabledInt, now, existing.id);

  syncModelsToCustomModels(endpointId);

  return {
    id: modelId,
    upstream_id: upstreamId,
    name,
    enabled: enabledInt === 1,
    quota_enabled: quotaEnabledInt === 1,
  };
}

export function deleteCustomEndpointModel(
  endpointId: string,
  modelIdOrUpstreamId: string
): boolean {
  const raw = decodeURIComponent(modelIdOrUpstreamId).trim();
  const stripped = raw.startsWith(`${endpointId}/`) ? raw.slice(endpointId.length + 1) : raw;
  const existing = getDbInstance()
    .prepare(
      `SELECT id FROM bp_custom_models
       WHERE endpoint_id = ? AND (id = ? OR upstream_id = ? OR id = ? OR upstream_id = ?)`
    )
    .get(endpointId, raw, raw, `${endpointId}/${raw}`, stripped) as { id: string } | undefined;
  if (!existing) return false;

  getDbInstance().prepare("DELETE FROM bp_custom_models WHERE id = ?").run(existing.id);
  getDbInstance()
    .prepare("DELETE FROM combos WHERE name = ? OR name = ?")
    .run("combo/" + existing.id, "combo/" + endpointId + "/" + raw);
  invalidateDbCache("combos");
  syncModelsToCustomModels(endpointId);
  return true;
}

export function getDecryptedEndpointApiKey(endpointId: string): string | null {
  const row = getDbInstance()
    .prepare("SELECT api_key_ciphertext FROM bp_custom_endpoints WHERE id = ?")
    .get(endpointId) as { api_key_ciphertext: string | null } | undefined;

  if (!row?.api_key_ciphertext) return null;
  return decrypt(row.api_key_ciphertext) ?? null;
}

export function isCustomModelQuotaExempt(modelId: string): boolean {
  if (!modelId) return false;
  try {
    const stripped = modelId.replace(/^combo\//, "").replace(/^custom\//, "");
    const row = getDbInstance()
      .prepare(
        `SELECT quota_enabled FROM bp_custom_models
         WHERE id = ? OR upstream_id = ? OR id = ? OR upstream_id = ?`
      )
      .get(modelId, modelId, stripped, stripped) as { quota_enabled: number } | undefined;

    if (row) return row.quota_enabled === 0;

    // Check if modelId is a combo in combos table
    const comboRow = getDbInstance()
      .prepare("SELECT data FROM combos WHERE name = ? OR id = ?")
      .get(modelId, modelId) as { data: string } | undefined;
    if (comboRow) {
      const data = JSON.parse(comboRow.data);
      const models = Array.isArray(data.models) ? data.models : [];
      if (models.length > 0) {
        const targets = models
          .map((m: any) => (typeof m === "string" ? m : m?.model || ""))
          .filter(Boolean);
        if (targets.length > 0 && targets.every((t: string) => isCustomModelQuotaExempt(t))) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function getCustomModelInfo(modelId: string): {
  endpointId: string;
  upstreamId: string;
  enabled: boolean;
  quotaEnabled: boolean;
} | null {
  try {
    const row = getDbInstance()
      .prepare(
        `SELECT m.endpoint_id, m.upstream_id, m.enabled as model_enabled,
                e.enabled as endpoint_enabled, m.quota_enabled
         FROM bp_custom_models m
         JOIN bp_custom_endpoints e ON m.endpoint_id = e.id
         WHERE m.id = ? OR m.upstream_id = ?`
      )
      .get(modelId, modelId) as
      | {
          endpoint_id: string;
          upstream_id: string;
          model_enabled: number;
          endpoint_enabled: number;
          quota_enabled: number;
        }
      | undefined;

    if (!row) return null;
    return {
      endpointId: row.endpoint_id,
      upstreamId: row.upstream_id,
      enabled: row.model_enabled === 1 && row.endpoint_enabled === 1,
      quotaEnabled: row.quota_enabled === 1,
    };
  } catch {
    return null;
  }
}

function normalizeDigiOriginBase(rawUrl: string): string | null {
  try {
    const parsed = validateCustomEndpointUrl(rawUrl.trim());
    const cleanPath = parsed.pathname
      .replace(/\/+$/, "")
      .replace(/\/v1(?:\/(?:chat\/completions|messages|responses))?$/, "");
    return `${parsed.origin}${cleanPath}`;
  } catch {
    return null;
  }
}

export function reconcileCustomEndpointModelsFromDigiCatalog(
  activeModels: Array<{ model_id: string; display_name?: string | null }>,
  options?: { digiBaseUrl?: string | null }
): { endpoints_reconciled: number; models_enabled: number; models_disabled: number } {
  const db = getDbInstance();
  let endpoints: CustomEndpointRow[];
  try {
    endpoints = db
      .prepare("SELECT * FROM bp_custom_endpoints WHERE enabled = 1 ORDER BY created_at ASC")
      .all() as CustomEndpointRow[];
  } catch {
    return { endpoints_reconciled: 0, models_enabled: 0, models_disabled: 0 };
  }
  if (!endpoints.length) {
    return { endpoints_reconciled: 0, models_enabled: 0, models_disabled: 0 };
  }

  let targets = endpoints;
  if (options?.digiBaseUrl) {
    const normalizedTarget = normalizeDigiOriginBase(options.digiBaseUrl);
    if (normalizedTarget) {
      const matched = endpoints.filter(
        (ep) => normalizeDigiOriginBase(ep.base_url) === normalizedTarget
      );
      if (matched.length > 0) {
        targets = matched;
      }
    }
  }

  const activeMap = new Map<string, string | null>();
  for (const entry of activeModels) {
    const upstreamId = entry.model_id?.trim();
    if (!upstreamId) continue;
    const displayName = entry.display_name?.trim() || null;
    activeMap.set(upstreamId, displayName);
  }

  const now = new Date().toISOString();
  let modelsEnabled = 0;
  let modelsDisabled = 0;

  for (const endpoint of targets) {
    const existingRows = db
      .prepare("SELECT * FROM bp_custom_models WHERE endpoint_id = ?")
      .all(endpoint.id) as CustomModelRow[];
    const byUpstream = new Map(existingRows.map((row) => [row.upstream_id, row]));

    for (const [upstreamId, displayName] of activeMap.entries()) {
      const existing = byUpstream.get(upstreamId);
      if (existing) {
        const nextName = displayName ?? existing.name;
        if (existing.enabled !== 1 || nextName !== existing.name) {
          db.prepare(
            "UPDATE bp_custom_models SET enabled = 1, name = ?, updated_at = ? WHERE id = ?"
          ).run(nextName, now, existing.id);
        }
        modelsEnabled++;
      } else {
        const modelId = `${endpoint.id}/${upstreamId}`;
        db.prepare(
          `INSERT INTO bp_custom_models
           (id, endpoint_id, upstream_id, name, enabled, quota_enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, 1, ?, ?)`
        ).run(modelId, endpoint.id, upstreamId, displayName ?? upstreamId, now, now);
        modelsEnabled++;
      }
    }

    for (const existing of existingRows) {
      if (!activeMap.has(existing.upstream_id)) {
        if (existing.enabled !== 0) {
          db.prepare("UPDATE bp_custom_models SET enabled = 0, updated_at = ? WHERE id = ?").run(
            now,
            existing.id
          );
          modelsDisabled++;
        }
      }
    }

    syncModelsToCustomModels(endpoint.id);
  }

  return {
    endpoints_reconciled: targets.length,
    models_enabled: modelsEnabled,
    models_disabled: modelsDisabled,
  };
}

export function getActiveCustomEndpointOffers(): Array<{
  id: string;
  upstream_id: string;
  endpoint_id: string;
  name: string;
}> {
  try {
    const rows = getDbInstance()
      .prepare(
        `SELECT m.id, m.upstream_id, m.endpoint_id, m.name
         FROM bp_custom_models m
         JOIN bp_custom_endpoints e ON m.endpoint_id = e.id
         WHERE m.enabled = 1 AND e.enabled = 1`
      )
      .all() as Array<{
      id: string;
      upstream_id: string;
      endpoint_id: string;
      name: string;
    }>;
    if (!hasSyncedDigiCatalog()) return rows;
    const activeDigiIds = getActiveDigiModelIds();
    return rows.filter((r) => activeDigiIds.has(r.upstream_id) || activeDigiIds.has(r.id));
  } catch {
    return [];
  }
}

export function getDisabledCustomModelIds(): Set<string> {
  try {
    const rows = getDbInstance()
      .prepare(
        `SELECT m.id, m.upstream_id, m.endpoint_id, m.enabled as model_enabled, e.enabled as endpoint_enabled
         FROM bp_custom_models m
         JOIN bp_custom_endpoints e ON m.endpoint_id = e.id`
      )
      .all() as Array<{
      id: string;
      upstream_id: string;
      endpoint_id: string;
      model_enabled: number;
      endpoint_enabled: number;
    }>;

    const syncedCatalog = hasSyncedDigiCatalog();
    const activeDigiIds = syncedCatalog ? getActiveDigiModelIds() : null;
    const set = new Set<string>();
    for (const r of rows) {
      const inactiveInDigi =
        syncedCatalog && !activeDigiIds!.has(r.upstream_id) && !activeDigiIds!.has(r.id);
      if (r.model_enabled === 0 || r.endpoint_enabled === 0 || inactiveInDigi) {
        set.add(r.id);
        set.add(`${r.endpoint_id}/${r.upstream_id}`);
      }
    }
    return set;
  } catch {
    return new Set<string>();
  }
}
