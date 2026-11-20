import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-digi-sync-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.STORAGE_ENCRYPTION_KEY = "synthetic-digi-sync-storage-key-1234567890";

const core = await import("../../src/lib/db/core.ts");
const quotas = await import("../../src/lib/db/bpbatamQuotas.ts");
const digiDb = await import("../../src/lib/db/bpbatamDigiSync.ts");
const customEndpoints = await import("../../src/lib/db/bpbatamCustomEndpoints.ts");
const syncMod = await import("../../src/lib/bpbatam/digiCreditSync.ts");
const { classifyRoute } = await import("../../src/server/authz/classify.ts");
const syncRoute = await import("../../src/app/api/bpbatam/digi-credit-sync/route.ts");

const prevSecret = process.env.DIGI_ROUTE_SYNC_SECRET;
const prevDigiUrl = process.env.DIGI_ROUTE_URL;
const prevDigiKey = process.env.DIGI_ROUTE_API_KEY;
const prevTopupUrl = process.env.DIGI_TOPUP_LANDING_URL;
const prevLegacyTopupUrl = process.env.DIGI_ROUTE_TOPUP_URL;

test.after(() => {
  if (prevSecret === undefined) delete process.env.DIGI_ROUTE_SYNC_SECRET;
  else process.env.DIGI_ROUTE_SYNC_SECRET = prevSecret;
  if (prevDigiUrl === undefined) delete process.env.DIGI_ROUTE_URL;
  else process.env.DIGI_ROUTE_URL = prevDigiUrl;
  if (prevDigiKey === undefined) delete process.env.DIGI_ROUTE_API_KEY;
  else process.env.DIGI_ROUTE_API_KEY = prevDigiKey;
  if (prevTopupUrl === undefined) delete process.env.DIGI_TOPUP_LANDING_URL;
  else process.env.DIGI_TOPUP_LANDING_URL = prevTopupUrl;
  if (prevLegacyTopupUrl === undefined) delete process.env.DIGI_ROUTE_TOPUP_URL;
  else process.env.DIGI_ROUTE_TOPUP_URL = prevLegacyTopupUrl;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function buildSampleGrant(overrides: Record<string, unknown> = {}) {
  return {
    command_id: "dgr-grant-9f81c2a0-7b1e-4e92-812c-110293847561",
    tenant_id: "bpbatam",
    order_id: "ORD-20261119-001",
    mode: "add",
    credits_granted: "200.000000",
    credits_granted_micro: 200_000_000,
    economic_snapshot: {
      base_credit_rupiah: 5000,
      usd_idr_rate: 18255,
      ref_tokens_per_credit: 152200,
    },
    model_credit_rates: [
      {
        model_id: "gpt-6.1-terra",
        input_micro_credits_per_1m: 3_651_000,
        cached_micro_credits_per_1m: 182_550,
        output_micro_credits_per_1m: 18_255_000,
      },
      {
        model_id: "gpt-6-luna",
        input_micro_credits_per_1m: 365_100,
        cached_micro_credits_per_1m: 36_510,
        output_micro_credits_per_1m: 1_825_500,
      },
    ],
    issued_at: "2026-11-19T12:00:00Z",
    ...overrides,
  };
}

test("route classification marks /api/bpbatam/digi-credit-sync exact PUBLIC and keeps siblings MANAGEMENT", () => {
  assert.equal(classifyRoute("/api/bpbatam/digi-credit-sync", "POST").routeClass, "PUBLIC");
  assert.equal(classifyRoute("/api/bpbatam/digi-credit-sync-x", "POST").routeClass, "MANAGEMENT");
  assert.equal(classifyRoute("/api/bpbatam/pool", "GET").routeClass, "MANAGEMENT");
});

test("POST /api/bpbatam/digi-credit-sync fails closed when secret is missing or signature is invalid", async () => {
  delete process.env.DIGI_ROUTE_SYNC_SECRET;
  const unsigned = buildSampleGrant();
  const missingSecretRes = await syncRoute.POST(
    new Request("http://localhost/api/bpbatam/digi-credit-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...unsigned, signature: "hmac-sha256=" + "0".repeat(64) }),
    })
  );
  assert.equal(missingSecretRes.status, 503);
  assert.equal(
    ((await missingSecretRes.json()) as { code: string }).code,
    "SYNC_SECRET_NOT_CONFIGURED"
  );

  process.env.DIGI_ROUTE_SYNC_SECRET = "test-digi-sync-hmac-secret";

  const badSigRes = await syncRoute.POST(
    new Request("http://localhost/api/bpbatam/digi-credit-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...unsigned, signature: "hmac-sha256=" + "a".repeat(64) }),
    })
  );
  assert.equal(badSigRes.status, 401);
  assert.equal(((await badSigRes.json()) as { code: string }).code, "INVALID_SYNC_SIGNATURE");

  const validSig = syncMod.signDigiCreditSyncPayload(unsigned, "test-digi-sync-hmac-secret");
  const tamperedRes = await syncRoute.POST(
    new Request("http://localhost/api/bpbatam/digi-credit-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...unsigned,
        credits_granted: "500.000000",
        credits_granted_micro: 500_000_000,
        signature: validSig,
      }),
    })
  );
  assert.equal(tamperedRes.status, 401);
});

test("POST /api/bpbatam/digi-credit-sync verifies HMAC, rejects wrong tenant, grants credits idempotently, and stores model rates", async () => {
  process.env.DIGI_ROUTE_SYNC_SECRET = "test-digi-sync-hmac-secret";

  const wrongTenant = buildSampleGrant({
    command_id: "dgr-grant-wrong-tenant",
    tenant_id: "other-org",
  });
  const wrongTenantSig = syncMod.signDigiCreditSyncPayload(
    wrongTenant,
    "test-digi-sync-hmac-secret"
  );
  const wrongTenantRes = await syncRoute.POST(
    new Request("http://localhost/api/bpbatam/digi-credit-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...wrongTenant, signature: wrongTenantSig }),
    })
  );
  assert.equal(wrongTenantRes.status, 403);
  assert.equal(((await wrongTenantRes.json()) as { code: string }).code, "TENANT_MISMATCH");

  const payload = buildSampleGrant();
  const signature = syncMod.signDigiCreditSyncPayload(payload, "test-digi-sync-hmac-secret");

  const res1 = await syncRoute.POST(
    new Request("http://localhost/api/bpbatam/digi-credit-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, signature }),
    })
  );
  assert.equal(res1.status, 200);
  const body1 = (await res1.json()) as Record<string, unknown>;
  assert.equal(body1.status, "applied");
  assert.equal(body1.credits_granted_micro, 200_000_000);
  assert.equal(quotas.poolStatus("bpbatam").issued_micro, 200_000_000);
  assert.equal(quotas.poolStatus("bpbatam").remaining_credits, "200.000000");

  const terraRate = digiDb.getDigiModelCreditRate("gpt-6.1-terra");
  assert.ok(terraRate);
  assert.equal(terraRate.input_micro_credits_per_1m, 3_651_000);
  assert.equal(terraRate.output_micro_credits_per_1m, 18_255_000);

  // Replay with identical command_id + payload returns 200 replayed without double-crediting
  const res2 = await syncRoute.POST(
    new Request("http://localhost/api/bpbatam/digi-credit-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, signature }),
    })
  );
  assert.equal(res2.status, 200);
  assert.equal(((await res2.json()) as { status: string }).status, "replayed");
  assert.equal(quotas.poolStatus("bpbatam").issued_micro, 200_000_000);

  // Retry-sync with fresh issued_at and updated model_credit_rates still replays idempotently
  const retryFreshPayload = buildSampleGrant({
    issued_at: "2026-11-19T12:05:00Z",
    model_credit_rates: [
      {
        model_id: "gpt-6.1-terra",
        input_micro_credits_per_1m: 4_000_000,
        cached_micro_credits_per_1m: 200_000,
        output_micro_credits_per_1m: 20_000_000,
      },
    ],
  });
  const retryFreshSig = syncMod.signDigiCreditSyncPayload(
    retryFreshPayload,
    "test-digi-sync-hmac-secret"
  );
  const resRetryFresh = await syncRoute.POST(
    new Request("http://localhost/api/bpbatam/digi-credit-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...retryFreshPayload, signature: retryFreshSig }),
    })
  );
  assert.equal(resRetryFresh.status, 200);
  assert.equal(((await resRetryFresh.json()) as { status: string }).status, "replayed");
  assert.equal(quotas.poolStatus("bpbatam").issued_micro, 200_000_000);

  // Conflict when same command_id has different amount
  const conflictPayload = buildSampleGrant({
    credits_granted: "300.000000",
    credits_granted_micro: 300_000_000,
  });
  const conflictSig = syncMod.signDigiCreditSyncPayload(
    conflictPayload,
    "test-digi-sync-hmac-secret"
  );
  const resConflict = await syncRoute.POST(
    new Request("http://localhost/api/bpbatam/digi-credit-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...conflictPayload, signature: conflictSig }),
    })
  );
  assert.equal(resConflict.status, 409);
  assert.equal(((await resConflict.json()) as { code: string }).code, "IDEMPOTENCY_CONFLICT");
});

test("POST /api/bpbatam/digi-credit-sync reconciles active catalog by marking omitted models inactive and reactivating re-enabled models", async () => {
  process.env.DIGI_ROUTE_SYNC_SECRET = "test-digi-sync-hmac-secret";

  // Previous test synced gpt-6.1-terra and gpt-6-luna; now Digi Route disables gpt-6-luna and adds gpt-astra
  const catalogSync = {
    command_id: "dgr-cat-sync-deactivate-luna",
    tenant_id: "bpbatam",
    mode: "sync",
    credits_granted: "0.000000",
    credits_granted_micro: 0,
    economic_snapshot: {
      base_credit_rupiah: 5000,
      usd_idr_rate: 18100,
      ref_tokens_per_credit: 155000,
      revision: 4,
    },
    model_credit_rates: [
      {
        model_id: "gpt-6.1-terra",
        input_micro_credits_per_1m: 3_600_000,
        cached_micro_credits_per_1m: 180_000,
        output_micro_credits_per_1m: 18_000_000,
      },
      {
        model_id: "gpt-astra",
        input_micro_credits_per_1m: 1_500_000,
        cached_micro_credits_per_1m: 75_000,
        output_micro_credits_per_1m: 7_500_000,
      },
    ],
    issued_at: "2026-11-19T13:00:00Z",
  };
  const sig = syncMod.signDigiCreditSyncPayload(catalogSync, "test-digi-sync-hmac-secret");
  const res = await syncRoute.POST(
    new Request("http://localhost/api/bpbatam/digi-credit-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...catalogSync, signature: sig }),
    })
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.status, "applied");
  assert.deepEqual(body.catalog, { active_models: 2, deactivated_models: 1 });

  // Active rates list only contains active models
  const activeRates = digiDb.listDigiModelCreditRates();
  assert.deepEqual(
    activeRates.map((r) => r.model_id),
    ["gpt-6.1-terra", "gpt-astra"]
  );
  // Disabled model is NOT returned by getDigiModelCreditRate, but preserved as active=0 in DB
  assert.equal(digiDb.getDigiModelCreditRate("gpt-6-luna"), undefined);
  const allRates = digiDb.listDigiModelCreditRates({ includeInactive: true });
  const lunaRow = allRates.find((r) => r.model_id === "gpt-6-luna");
  assert.ok(lunaRow, "deactivated model row should remain persisted with active=0");
  assert.equal(lunaRow.active, 0);
});

test("syncFromDigiRoute / pullDigiCreditBalance resolves configured custom endpoint URL + encrypted API key and reconciles /api/v1/digi-credit/catalog", async () => {
  delete process.env.DIGI_ROUTE_URL;
  delete process.env.DIGI_ROUTE_API_KEY;

  const seenAuthHeaders: Record<string, string> = {};
  let catalogActiveModels = [
    {
      model_id: "gpt-6.1-terra",
      display_name: "GPT 6.1 Terra",
      provider: "openai",
      category: "chat",
      billing_unit: "tokens_1m",
      enabled: 1,
    },
    {
      model_id: "claude-sonnet-4",
      display_name: "Claude Sonnet 4",
      provider: "anthropic",
      category: "chat",
      billing_unit: "tokens_1m",
      enabled: 1,
    },
  ];
  let catalogRates = [
    {
      model_id: "gpt-6.1-terra",
      input_micro_credits_per_1m: 3_651_000,
      cached_micro_credits_per_1m: 182_550,
      output_micro_credits_per_1m: 18_255_000,
      unit_micro_credits: 0,
      request_fee_micro_credits: 0,
      billing_unit: "tokens_1m",
    },
    {
      model_id: "claude-sonnet-4",
      input_micro_credits_per_1m: 4_200_000,
      cached_micro_credits_per_1m: 420_000,
      output_micro_credits_per_1m: 21_000_000,
      unit_micro_credits: 0,
      request_fee_micro_credits: 0,
      billing_unit: "tokens_1m",
    },
    {
      model_id: "gpt-astra",
      input_micro_credits_per_1m: 1_500_000,
      cached_micro_credits_per_1m: 75_000,
      output_micro_credits_per_1m: 7_500_000,
      unit_micro_credits: 0,
      request_fee_micro_credits: 0,
      billing_unit: "tokens_1m",
    },
  ];
  let catalogCombos = [
    {
      combo_id: "gpt-astra",
      display_name: "GPT Astra",
      enabled: 1,
      is_passthrough: 0,
    },
  ];

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    seenAuthHeaders[pathname] = String(req.headers.authorization ?? "");
    if (pathname === "/api/v1/digi-credit/balance") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          tenant_id: "bpbatam",
          account_id: "bproute-bpbatam",
          balance_micro: 250_000_000,
          reserved_micro: 0,
          available_micro: 250_000_000,
          economic_snapshot: {
            base_credit_rupiah: 5000,
            usd_idr_rate: 18255,
            ref_tokens_per_credit: 152200,
            revision: 5,
          },
        })
      );
      return;
    }
    if (pathname === "/api/v1/digi-credit/catalog") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          economic_snapshot: {
            base_credit_rupiah: 5000,
            usd_idr_rate: 18255,
            ref_tokens_per_credit: 152200,
            revision: 5,
          },
          model_credit_rates: catalogRates,
          models: catalogActiveModels,
          combos: catalogCombos,
          issued_at: "2026-11-19T14:00:00Z",
        })
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;

  // Configure Digi Route purely via BP Route Custom Endpoint (OpenAI-compatible) + encrypted API key
  const ep = customEndpoints.createCustomEndpoint({
    name: "Digi Route Primary",
    base_url: `http://127.0.0.1:${addr.port}/v1`,
    enabled: true,
    api_key: "dgr-custom-ep-secret-key",
  });
  // Pre-seed a stale model on this custom endpoint that Digi Route does NOT offer
  customEndpoints.createCustomEndpointModel(ep.id, {
    upstream_id: "stale-local-only-model",
    name: "Stale Local Only",
    enabled: true,
  });

  try {
    const syncResult = await syncMod.syncFromDigiRoute("bpbatam");
    assert.equal(syncResult.synced, true);
    assert.equal(seenAuthHeaders["/api/v1/digi-credit/balance"], "Bearer dgr-custom-ep-secret-key");
    assert.equal(seenAuthHeaders["/api/v1/digi-credit/catalog"], "Bearer dgr-custom-ep-secret-key");
    assert.equal(syncResult.catalog.synced, true);
    assert.equal(syncResult.catalog.active_models, 3);

    // Active rates include metadata from catalog
    const sonnet = digiDb.getDigiModelCreditRate("claude-sonnet-4");
    assert.ok(sonnet);
    assert.equal(sonnet.active, 1);
    assert.equal(sonnet.display_name, "Claude Sonnet 4");
    assert.equal(sonnet.provider, "anthropic");

    // Custom endpoint models were reconciled: active Digi models enabled, stale model disabled
    const epAfter1 = customEndpoints.getCustomEndpoint(ep.id)!;
    const enabledUpstreamIds = epAfter1.models
      .filter((m) => m.enabled)
      .map((m) => m.upstream_id)
      .sort();
    assert.deepEqual(enabledUpstreamIds, ["claude-sonnet-4", "gpt-6.1-terra", "gpt-astra"]);
    const staleModel = epAfter1.models.find((m) => m.upstream_id === "stale-local-only-model");
    assert.ok(staleModel);
    assert.equal(staleModel.enabled, false);

    // Now Digi Route disables claude-sonnet-4 and gpt-astra
    catalogActiveModels = catalogActiveModels.filter((m) => m.model_id === "gpt-6.1-terra");
    catalogRates = catalogRates.filter((r) => r.model_id === "gpt-6.1-terra");
    catalogCombos = [];

    const syncResult2 = await syncMod.pullDigiCreditBalance("bpbatam");
    assert.equal(syncResult2.catalog.synced, true);
    assert.equal(syncResult2.catalog.active_models, 1);
    assert.equal(syncResult2.catalog.deactivated_models, 2);

    assert.equal(digiDb.getDigiModelCreditRate("claude-sonnet-4"), undefined);
    assert.equal(digiDb.getDigiModelCreditRate("gpt-astra"), undefined);
    assert.ok(digiDb.getDigiModelCreditRate("gpt-6.1-terra"));

    const epAfter2 = customEndpoints.getCustomEndpoint(ep.id)!;
    assert.deepEqual(
      epAfter2.models.filter((m) => m.enabled).map((m) => m.upstream_id),
      ["gpt-6.1-terra"]
    );
  } finally {
    customEndpoints.deleteCustomEndpoint(ep.id);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Top-Up deep-link defaults to Hellodigi Portal and honors DIGI_TOPUP_LANDING_URL", () => {
  delete process.env.DIGI_TOPUP_LANDING_URL;
  delete process.env.DIGI_ROUTE_TOPUP_URL;
  delete process.env.NEXT_PUBLIC_DIGI_ROUTE_TOPUP_URL;
  assert.equal(syncMod.buildTopUpLandingUrl("bpbatam"), "http://127.0.0.1:3090/?tenant_id=bpbatam");

  process.env.DIGI_TOPUP_LANDING_URL = "https://portal.example.id/topup";
  assert.equal(
    syncMod.buildTopUpLandingUrl("bpbatam"),
    "https://portal.example.id/topup?tenant_id=bpbatam"
  );
});
