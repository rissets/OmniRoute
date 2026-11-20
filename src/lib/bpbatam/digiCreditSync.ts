import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  account,
  allocate,
  createAccount,
  TokenPolicyError,
  withinTransaction,
} from "@/lib/db/bpbatam";
import { poolStatus, setPoolCap } from "@/lib/db/bpbatamQuotas";
import {
  getDigiCreditGrant,
  getDigiCreditSyncState,
  getDigiModelCreditRate,
  insertDigiCreditGrant,
  listConfiguredDigiRouteTargets,
  reconcileDigiModelCreditRates,
  upsertDigiCreditSyncState,
  type DigiCatalogReconcileSummary,
  type DigiModelCreditRate,
  type DigiModelCreditRateUpsertInput,
} from "@/lib/db/bpbatamDigiSync";
import { reconcileCustomEndpointModelsFromDigiCatalog } from "@/lib/db/bpbatamCustomEndpoints";
import { validateCustomEndpointUrl } from "./customTransport";
import {
  creditsToMicroCredits,
  DEFAULT_BASE_CREDIT_RUPIAH,
  DEFAULT_REF_TOKENS_PER_CREDIT,
  DEFAULT_USD_IDR_RATE,
} from "./creditUnits";
import {
  BoundError,
  DEFAULT_CHAT_OUTPUT_LIMIT,
  reservationBound,
  type CanonicalUsage,
} from "./usage";

export interface DigiCreditSyncRateInput {
  model_id: string;
  input_micro_credits_per_1m: number;
  cached_micro_credits_per_1m?: number;
  output_micro_credits_per_1m: number;
  unit_micro_credits?: number;
  request_fee_micro_credits?: number;
  billing_unit?: string;
}

export interface DigiCreditSyncPayload {
  command_id: string;
  tenant_id: string;
  order_id?: string;
  mode: "add" | "sync";
  credits_granted?: string;
  credits_granted_micro: number;
  economic_snapshot?: {
    base_credit_rupiah?: number;
    usd_idr_rate?: number;
    ref_tokens_per_credit?: number;
    revision?: number;
  };
  model_credit_rates?: DigiCreditSyncRateInput[];
  issued_at: string;
  signature?: string;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) {
        out[key] = sortJsonValue(entry);
      }
    }
    return out;
  }
  return value;
}

export function canonicalizeSyncPayload(payload: Record<string, unknown>): string {
  const clone: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(payload)) {
    if (key !== "signature" && val !== undefined) {
      clone[key] = val;
    }
  }
  return JSON.stringify(sortJsonValue(clone));
}

export function getDigiCreditSyncSecret(): string {
  return (process.env.DIGI_ROUTE_SYNC_SECRET || process.env.BPBATAM_DIGI_SYNC_SECRET || "").trim();
}

export function signDigiCreditSyncPayload(
  payload: Record<string, unknown>,
  secret = getDigiCreditSyncSecret()
): string {
  if (!secret) {
    throw new TokenPolicyError("SYNC_SECRET_NOT_CONFIGURED", 503);
  }
  const canonical = canonicalizeSyncPayload(payload);
  const digest = createHmac("sha256", secret).update(canonical).digest("hex");
  return `hmac-sha256=${digest}`;
}

function normalizeHexSignature(raw: string): Buffer | null {
  const trimmed = raw.trim();
  const hex = trimmed.toLowerCase().startsWith("hmac-sha256=")
    ? trimmed.slice("hmac-sha256=".length)
    : trimmed;
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  return Buffer.from(hex, "hex");
}

export function verifyDigiCreditSyncSignature(
  payload: Record<string, unknown>,
  rawSignature?: string | null,
  rawBody?: string | null
): void {
  const secret = getDigiCreditSyncSecret();
  if (!secret) {
    throw new TokenPolicyError("SYNC_SECRET_NOT_CONFIGURED", 503);
  }
  const sigInput =
    rawSignature ?? (typeof payload.signature === "string" ? payload.signature : null);
  if (!sigInput) {
    throw new TokenPolicyError("INVALID_SYNC_SIGNATURE", 401);
  }
  const provided = normalizeHexSignature(sigInput);
  if (!provided) {
    throw new TokenPolicyError("INVALID_SYNC_SIGNATURE", 401);
  }

  const canonical = canonicalizeSyncPayload(payload);
  const expectedCanonical = createHmac("sha256", secret).update(canonical).digest();
  if (
    provided.length === expectedCanonical.length &&
    timingSafeEqual(provided, expectedCanonical)
  ) {
    return;
  }

  if (rawBody) {
    const expectedRaw = createHmac("sha256", secret).update(rawBody).digest();
    if (provided.length === expectedRaw.length && timingSafeEqual(provided, expectedRaw)) {
      return;
    }
  }

  throw new TokenPolicyError("INVALID_SYNC_SIGNATURE", 401);
}

export function applySignedDigiCreditSync(
  payload: DigiCreditSyncPayload,
  options?: { rawSignature?: string | null; rawBody?: string | null }
) {
  verifyDigiCreditSyncSignature(
    payload as unknown as Record<string, unknown>,
    options?.rawSignature,
    options?.rawBody
  );

  const expectedTenant = process.env.BPBATAM_CP_ACCOUNT ?? "bpbatam";
  if (payload.tenant_id !== expectedTenant) {
    throw new TokenPolicyError("TENANT_MISMATCH", 403);
  }

  if (!Number.isFinite(Date.parse(payload.issued_at))) {
    throw new TokenPolicyError("INVALID_ISSUED_AT", 422);
  }

  if (payload.credits_granted !== undefined) {
    let expectedMicro: number;
    try {
      expectedMicro = creditsToMicroCredits(payload.credits_granted);
    } catch {
      throw new TokenPolicyError("INVALID_CREDITS_GRANTED", 422);
    }
    if (expectedMicro !== payload.credits_granted_micro) {
      throw new TokenPolicyError("CREDITS_MISMATCH", 422);
    }
  }

  if (payload.mode === "add" && payload.credits_granted_micro <= 0) {
    throw new TokenPolicyError("INVALID_POOL_AMOUNT", 422);
  }

  const hashPayload = canonicalizeSyncPayload({
    command_id: payload.command_id,
    tenant_id: payload.tenant_id,
    order_id: payload.order_id ?? null,
    mode: payload.mode,
    credits_granted_micro: payload.credits_granted_micro,
  });
  const payloadHash = createHash("sha256").update(hashPayload).digest("hex");

  return withinTransaction(() => {
    const prior = getDigiCreditGrant(payload.command_id);
    if (prior) {
      if (prior.payload_hash !== payloadHash) {
        throw new TokenPolicyError("IDEMPOTENCY_CONFLICT", 409);
      }
      return {
        status: "replayed" as const,
        command_id: payload.command_id,
        credits_granted_micro: prior.credits_granted_micro,
        pool: poolStatus(expectedTenant),
      };
    }

    if (!account(expectedTenant)) {
      createAccount(expectedTenant, null, "platform");
    }

    if (payload.credits_granted_micro > 0) {
      const before = poolStatus(expectedTenant);
      const nextTotalIssued = before.issued_micro + payload.credits_granted_micro;
      setPoolCap(expectedTenant, Math.max(before.ceiling_micro, nextTotalIssued));
      allocate(
        `digi:${payload.command_id}`,
        null,
        expectedTenant,
        payload.credits_granted_micro,
        "digi-route-sync"
      );
    }

    const currentSync = getDigiCreditSyncState(expectedTenant);
    const snap = payload.economic_snapshot;
    const nowIso = new Date().toISOString();
    const afterPool = poolStatus(expectedTenant);

    upsertDigiCreditSyncState(expectedTenant, {
      base_credit_rupiah: snap?.base_credit_rupiah ?? currentSync.base_credit_rupiah,
      usd_idr_rate: snap?.usd_idr_rate ?? currentSync.usd_idr_rate,
      ref_tokens_per_credit: snap?.ref_tokens_per_credit ?? currentSync.ref_tokens_per_credit,
      economic_revision: snap?.revision ?? currentSync.economic_revision,
      last_balance_micro:
        currentSync.last_balance_micro + payload.credits_granted_micro || afterPool.remaining_micro,
      last_available_micro:
        currentSync.last_available_micro + payload.credits_granted_micro ||
        afterPool.available_micro,
      last_synced_at: nowIso,
      last_sync_source: "push",
      last_sync_error: null,
    });

    // The pushed rate list is Digi Route's full active catalog: anything omitted becomes inactive.
    const catalog = payload.model_credit_rates?.length
      ? reconcileDigiModelCreditRates(payload.model_credit_rates)
      : undefined;
    if (catalog) upsertDigiCreditSyncState(expectedTenant, { catalog_synced_at: nowIso });

    insertDigiCreditGrant({
      command_id: payload.command_id,
      tenant_id: payload.tenant_id,
      order_id: payload.order_id ?? "",
      mode: payload.mode,
      credits_granted_micro: payload.credits_granted_micro,
      payload_hash: payloadHash,
      issued_at: payload.issued_at,
    });

    return {
      status: "applied" as const,
      command_id: payload.command_id,
      credits_granted_micro: payload.credits_granted_micro,
      pool: poolStatus(expectedTenant),
      ...(catalog && {
        catalog: {
          active_models: catalog.active_models,
          deactivated_models: catalog.deactivated_models,
        },
      }),
    };
  });
}

function normalizeDigiBaseUrl(candidate: string | undefined): string | null {
  if (!candidate || !candidate.trim()) return null;
  try {
    const parsed = validateCustomEndpointUrl(candidate.trim());
    const cleanPath = parsed.pathname
      .replace(/\/+$/, "")
      .replace(/\/v1(?:\/(?:chat\/completions|messages|responses))?$/, "");
    return `${parsed.origin}${cleanPath}`;
  } catch {
    return null;
  }
}

// Order: explicit override, env, then enabled BP Route custom endpoints / compatible provider nodes.
export function resolveDigiRouteTarget(
  overrideUrl?: string
): { baseUrl: string; apiKey: string | null } | null {
  const targets = listConfiguredDigiRouteTargets();
  for (const candidate of [
    overrideUrl,
    process.env.DIGI_ROUTE_URL,
    process.env.BPBATAM_DIGI_ROUTE_URL,
  ]) {
    const baseUrl = normalizeDigiBaseUrl(candidate);
    if (!baseUrl) continue;
    const match = targets.find((t) => normalizeDigiBaseUrl(t.baseUrl) === baseUrl);
    return { baseUrl, apiKey: match?.apiKey ?? null };
  }
  for (const t of targets) {
    const baseUrl = normalizeDigiBaseUrl(t.baseUrl);
    if (baseUrl) return { baseUrl, apiKey: t.apiKey };
  }
  return null;
}

export function resolveDigiRouteBaseUrl(overrideUrl?: string): string | null {
  return resolveDigiRouteTarget(overrideUrl)?.baseUrl ?? null;
}

// Top-up pool credit is purchased in Hellodigi Portal, not Digi Route.
export const DEFAULT_TOPUP_LANDING_URL = "http://127.0.0.1:3090";

export function buildTopUpLandingUrl(tenantId = "bpbatam"): string {
  const configured =
    process.env.DIGI_TOPUP_LANDING_URL ||
    process.env.DIGI_ROUTE_TOPUP_URL ||
    process.env.NEXT_PUBLIC_DIGI_ROUTE_TOPUP_URL;
  const rawBase = configured?.trim() || DEFAULT_TOPUP_LANDING_URL;
  try {
    const url = new URL(rawBase);
    if (!url.searchParams.has("tenant_id")) {
      url.searchParams.set("tenant_id", tenantId);
    }
    return url.toString();
  } catch {
    const sep = rawBase.includes("?") ? "&" : "?";
    return `${rawBase}${sep}tenant_id=${encodeURIComponent(tenantId)}`;
  }
}

export interface PullDigiCreditBalanceResult {
  synced: true;
  delta_micro: number;
  remote: {
    tenant_id: string;
    account_id: string | null;
    balance_micro: number;
    reserved_micro: number;
    available_micro: number;
    economic_snapshot?: {
      base_credit_rupiah?: number;
      usd_idr_rate?: number;
      ref_tokens_per_credit?: number;
      revision?: number;
    };
  };
  pool: ReturnType<typeof poolStatus>;
  catalog: DigiCatalogSyncResult;
}

export type DigiCatalogSyncResult =
  | ({ synced: true; endpoints_reconciled: number } & Omit<
      DigiCatalogReconcileSummary,
      "active_model_ids"
    >)
  | { synced: false; error: string };

interface DigiCatalogResponse {
  economic_snapshot?: PullDigiCreditBalanceResult["remote"]["economic_snapshot"];
  model_credit_rates?: DigiModelCreditRateUpsertInput[];
  models?: Array<{
    model_id: string;
    display_name?: string | null;
    provider?: string | null;
    category?: string | null;
    billing_unit?: string | null;
    enabled?: number | boolean;
  }>;
  combos?: Array<{ combo_id: string; display_name?: string | null; enabled?: number | boolean }>;
}

async function digiGet(fetchImpl: typeof fetch, url: URL, apiKey: string): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return fetchImpl(url.toString(), { method: "GET", headers, signal: AbortSignal.timeout(10_000) });
}

// Active = priced in Digi Route and not explicitly disabled there (model or combo).
function activeRatesFromCatalog(catalog: DigiCatalogResponse): DigiModelCreditRateUpsertInput[] {
  const meta = new Map<string, NonNullable<DigiCatalogResponse["models"]>[number]>();
  for (const m of catalog.models ?? []) meta.set(m.model_id, m);
  for (const c of catalog.combos ?? []) {
    if (!meta.has(c.combo_id)) meta.set(c.combo_id, { model_id: c.combo_id, ...c });
  }
  const out: DigiModelCreditRateUpsertInput[] = [];
  for (const rate of catalog.model_credit_rates ?? []) {
    const m = meta.get(rate.model_id);
    if (m && !m.enabled) continue;
    out.push({
      ...rate,
      billing_unit: rate.billing_unit ?? m?.billing_unit ?? undefined,
      display_name: m?.display_name ?? null,
      provider: m?.provider ?? null,
      category: m?.category ?? null,
    });
  }
  return out;
}

export async function pullDigiCreditBalance(
  tenantId = process.env.BPBATAM_CP_ACCOUNT ?? "bpbatam",
  options?: {
    digiRouteUrl?: string;
    apiKey?: string;
    fetchFn?: typeof fetch;
  }
): Promise<PullDigiCreditBalanceResult> {
  const target = resolveDigiRouteTarget(options?.digiRouteUrl);
  if (!target) {
    throw new TokenPolicyError("DIGI_ROUTE_URL_NOT_CONFIGURED", 503);
  }
  const { baseUrl } = target;
  const targetUrl = validateCustomEndpointUrl(
    `${baseUrl}/api/v1/digi-credit/balance?tenant_id=${encodeURIComponent(tenantId)}`
  );
  const apiKey = (
    options?.apiKey ??
    process.env.DIGI_ROUTE_API_KEY ??
    process.env.BPBATAM_DIGI_API_KEY ??
    target.apiKey ??
    ""
  ).trim();

  const fetchImpl = options?.fetchFn ?? fetch;

  let response: Response;
  try {
    response = await digiGet(fetchImpl, targetUrl, apiKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : "DIGI_ROUTE_UNREACHABLE";
    upsertDigiCreditSyncState(tenantId, { last_sync_error: message });
    throw new TokenPolicyError("DIGI_ROUTE_UNREACHABLE", 502);
  }

  if (!response.ok) {
    upsertDigiCreditSyncState(tenantId, {
      last_sync_error: `HTTP_${response.status}`,
    });
    throw new TokenPolicyError(`DIGI_ROUTE_SYNC_HTTP_${response.status}`, 502);
  }

  const remote = (await response.json()) as PullDigiCreditBalanceResult["remote"];
  if (
    !remote ||
    typeof remote.balance_micro !== "number" ||
    !Number.isSafeInteger(remote.balance_micro) ||
    remote.balance_micro < 0
  ) {
    upsertDigiCreditSyncState(tenantId, { last_sync_error: "INVALID_REMOTE_BALANCE" });
    throw new TokenPolicyError("INVALID_DIGI_BALANCE_RESPONSE", 502);
  }

  // Catalog failure must not fail the balance pull nor deactivate anything (fail-safe).
  let catalogResponse: DigiCatalogResponse | null = null;
  let catalogError = "";
  try {
    const catalogUrl = validateCustomEndpointUrl(
      `${baseUrl}/api/v1/digi-credit/catalog?tenant_id=${encodeURIComponent(tenantId)}`
    );
    const res = await digiGet(fetchImpl, catalogUrl, apiKey);
    if (!res.ok) catalogError = `CATALOG_HTTP_${res.status}`;
    else {
      const body = (await res.json()) as DigiCatalogResponse;
      if (Array.isArray(body?.model_credit_rates)) catalogResponse = body;
      else catalogError = "INVALID_CATALOG_RESPONSE";
    }
  } catch (err) {
    catalogError = err instanceof Error ? err.message : "CATALOG_UNREACHABLE";
  }

  return withinTransaction(() => {
    if (!account(tenantId)) {
      createAccount(tenantId, null, "platform");
    }
    const before = poolStatus(tenantId);
    const localRemaining = before.remaining_micro;
    const deltaMicro = Math.max(0, remote.balance_micro - localRemaining);

    if (deltaMicro > 0) {
      const commandId = `pull-sync:${tenantId}:${remote.balance_micro}:${before.issued_micro}`;
      const existingGrant = getDigiCreditGrant(commandId);
      if (!existingGrant) {
        const nextTotalIssued = before.issued_micro + deltaMicro;
        setPoolCap(tenantId, Math.max(before.ceiling_micro, nextTotalIssued));
        allocate(`digi:${commandId}`, null, tenantId, deltaMicro, "digi-route-pull-sync");
        insertDigiCreditGrant({
          command_id: commandId,
          tenant_id: tenantId,
          order_id: "",
          mode: "pull_sync",
          credits_granted_micro: deltaMicro,
          payload_hash: createHash("sha256")
            .update(JSON.stringify({ tenantId, remoteBalance: remote.balance_micro, deltaMicro }))
            .digest("hex"),
          issued_at: new Date().toISOString(),
        });
      }
    }

    let catalog: DigiCatalogSyncResult = { synced: false, error: catalogError };
    if (catalogResponse) {
      const active = activeRatesFromCatalog(catalogResponse);
      const summary = reconcileDigiModelCreditRates(active);
      const endpoints = reconcileCustomEndpointModelsFromDigiCatalog(
        active.map((r) => ({ model_id: r.model_id, display_name: r.display_name })),
        { digiBaseUrl: baseUrl }
      );
      catalog = {
        synced: true,
        active_models: summary.active_models,
        deactivated_models: summary.deactivated_models,
        endpoints_reconciled: endpoints.endpoints_reconciled,
      };
    }

    const snap = remote.economic_snapshot ?? catalogResponse?.economic_snapshot;
    upsertDigiCreditSyncState(tenantId, {
      digi_account_id: remote.account_id ?? null,
      last_balance_micro: remote.balance_micro,
      last_reserved_micro: remote.reserved_micro ?? 0,
      last_available_micro: remote.available_micro ?? remote.balance_micro,
      base_credit_rupiah: snap?.base_credit_rupiah ?? DEFAULT_BASE_CREDIT_RUPIAH,
      usd_idr_rate: snap?.usd_idr_rate ?? DEFAULT_USD_IDR_RATE,
      ref_tokens_per_credit: snap?.ref_tokens_per_credit ?? DEFAULT_REF_TOKENS_PER_CREDIT,
      economic_revision: snap?.revision ?? 1,
      last_synced_at: new Date().toISOString(),
      last_sync_source: "pull",
      last_sync_error: catalog.synced ? null : catalog.error,
      ...(catalog.synced && { catalog_synced_at: new Date().toISOString() }),
    });

    return {
      synced: true,
      delta_micro: deltaMicro,
      remote,
      pool: poolStatus(tenantId),
      catalog,
    };
  });
}

export const syncFromDigiRoute = pullDigiCreditBalance;

export function calculateReservationMicroCredits(opts: {
  path: string;
  model: string;
  body: Record<string, unknown>;
  modelInputBounds?: Record<string, unknown>;
  mediaCreditUnits?: Record<string, number>;
  mediaTokenUnits?: Record<string, number>;
}): {
  amount: number;
  unit: "micro_credits" | "token";
  rate?: DigiModelCreditRate;
  rawBoundTokens: number;
} {
  const {
    path,
    model,
    body,
    modelInputBounds = {},
    mediaCreditUnits = {},
    mediaTokenUnits = {},
  } = opts;
  const rate = getDigiModelCreditRate(model);

  // Token-based non-chat endpoints (/v1/embeddings, /v1/rerank, or any tokens_1m model on non-chat path)
  const isTokenInputNonChat =
    path === "/v1/embeddings" ||
    (path === "/v1/rerank" &&
      !mediaCreditUnits[path] &&
      !mediaTokenUnits[path] &&
      !(rate && rate.unit_micro_credits > 0)) ||
    (path !== "/v1/chat/completions" &&
      path !== "/v1/messages" &&
      path !== "/v1/responses" &&
      rate?.billing_unit === "tokens_1m" &&
      !mediaCreditUnits[path] &&
      !(rate.unit_micro_credits > 0));

  if (isTokenInputNonChat) {
    const boundSource =
      path === "/v1/rerank"
        ? { query: body.query ?? "", documents: body.documents ?? [], input: body.input ?? "" }
        : (body.input ?? body.query ?? "");
    const inputBound = Buffer.byteLength(JSON.stringify(boundSource)) + 128;
    if (rate) {
      const micro = Math.max(
        1,
        Math.ceil((inputBound / 1_000_000) * rate.input_micro_credits_per_1m) +
          rate.request_fee_micro_credits
      );
      return { amount: micro, unit: "micro_credits", rate, rawBoundTokens: inputBound };
    }
    return { amount: inputBound, unit: "token", rawBoundTokens: inputBound };
  }

  // Media / Speech / Image / Diarization paths
  if (path !== "/v1/chat/completions" && path !== "/v1/messages" && path !== "/v1/responses") {
    const creditUnit = mediaCreditUnits[path];
    if (typeof creditUnit === "number" && Number.isSafeInteger(creditUnit) && creditUnit > 0) {
      return { amount: creditUnit, unit: "micro_credits", rate, rawBoundTokens: creditUnit };
    }
    if (rate && rate.unit_micro_credits > 0) {
      return {
        amount: rate.unit_micro_credits + rate.request_fee_micro_credits,
        unit: "micro_credits",
        rate,
        rawBoundTokens: 1,
      };
    }
    const tokenUnit = mediaTokenUnits[path];
    if (typeof tokenUnit === "number" && Number.isSafeInteger(tokenUnit) && tokenUnit > 0) {
      return { amount: tokenUnit, unit: "token", rate, rawBoundTokens: tokenUnit };
    }
    throw new TokenPolicyError("MEDIA_UNIT_POLICY_REQUIRED", 503);
  }

  // Chat / Messages / Responses
  const totalTokenBound = reservationBound(body, modelInputBounds);
  const maxOutput = Number(
    body.max_completion_tokens ??
      body.max_tokens ??
      body.max_output_tokens ??
      DEFAULT_CHAT_OUTPUT_LIMIT
  );
  if (!Number.isSafeInteger(maxOutput) || maxOutput < 1) {
    throw new BoundError("OUTPUT_LIMIT_REQUIRED");
  }
  const inputBound = Math.max(0, totalTokenBound - maxOutput);

  if (rate) {
    const micro = Math.max(
      1,
      Math.ceil(
        (inputBound / 1_000_000) * rate.input_micro_credits_per_1m +
          (maxOutput / 1_000_000) * rate.output_micro_credits_per_1m
      ) + rate.request_fee_micro_credits
    );
    return { amount: micro, unit: "micro_credits", rate, rawBoundTokens: totalTokenBound };
  }

  return { amount: totalTokenBound, unit: "token", rawBoundTokens: totalTokenBound };
}

export function calculateSettlementMicroCredits(opts: {
  usage: CanonicalUsage;
  rate?: DigiModelCreditRate;
  digiCreditChargedMicro?: number | null;
}): { actual: number; unit: "micro_credits" | "token" } {
  const { usage, rate, digiCreditChargedMicro } = opts;

  if (
    typeof digiCreditChargedMicro === "number" &&
    Number.isSafeInteger(digiCreditChargedMicro) &&
    digiCreditChargedMicro >= 0
  ) {
    return { actual: digiCreditChargedMicro, unit: "micro_credits" };
  }

  if (rate) {
    const uncachedInput = Math.max(0, usage.input - usage.cached);
    const micro =
      Math.round(
        (uncachedInput / 1_000_000) * rate.input_micro_credits_per_1m +
          (usage.cached / 1_000_000) * rate.cached_micro_credits_per_1m +
          (usage.output / 1_000_000) * rate.output_micro_credits_per_1m
      ) + rate.request_fee_micro_credits;
    return { actual: Math.max(0, micro), unit: "micro_credits" };
  }

  return { actual: usage.total, unit: "token" };
}
