import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-bp-hardlock-api-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.JWT_SECRET = "test-jwt-secret-bp-hardlock-api";
process.env.INITIAL_PASSWORD = "admin-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const providerNodesRoute = await import("../../src/app/api/provider-nodes/route.ts");
const providerNodesValidateRoute =
  await import("../../src/app/api/provider-nodes/validate/route.ts");
const providersRoute = await import("../../src/app/api/providers/route.ts");
const providerByIdRoute = await import("../../src/app/api/providers/[id]/route.ts");
const providerTestRoute = await import("../../src/app/api/providers/[id]/test/route.ts");
const providersBulkRoute = await import("../../src/app/api/providers/bulk/route.ts");
const providersImportRoute = await import("../../src/app/api/providers/import/route.ts");
const providersValidateRoute = await import("../../src/app/api/providers/validate/route.ts");
const providersTestBatchRoute = await import("../../src/app/api/providers/test-batch/route.ts");
const providersFreeOnboardingRoute =
  await import("../../src/app/api/providers/free-onboarding/route.ts");
const providersClientRoute = await import("../../src/app/api/providers/client/route.ts");
const oauthActionRoute = await import("../../src/app/api/oauth/[provider]/[action]/route.ts");
const settingsRoute = await import("../../src/app/api/settings/route.ts");

const prevHardLock = process.env.BP_ROUTE_PROVIDER_HARD_LOCK;
const prevCc = process.env.ENABLE_CC_COMPATIBLE_PROVIDER;

interface JsonObject {
  [key: string]: unknown;
}

async function readJson(res: Response): Promise<JsonObject> {
  return (await res.json()) as JsonObject;
}

function resetDb() {
  process.env.BP_ROUTE_PROVIDER_HARD_LOCK = "true";
  delete process.env.ENABLE_CC_COMPATIBLE_PROVIDER;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(() => {
  resetDb();
});

test.after(() => {
  if (prevHardLock === undefined) delete process.env.BP_ROUTE_PROVIDER_HARD_LOCK;
  else process.env.BP_ROUTE_PROVIDER_HARD_LOCK = prevHardLock;
  if (prevCc === undefined) delete process.env.ENABLE_CC_COMPATIBLE_PROVIDER;
  else process.env.ENABLE_CC_COMPATIBLE_PROVIDER = prevCc;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("GET /api/provider-nodes enforces hard-lock flag, forces CC off, and filters disallowed nodes", async () => {
  process.env.ENABLE_CC_COMPATIBLE_PROVIDER = "true";

  await providersDb.createProviderNode({
    id: "openai-compatible-chat-digi",
    name: "Digi Route OpenAI",
    prefix: "digi-oai",
    type: "openai-compatible",
    apiType: "chat",
    baseUrl: "https://digi-route.example.com/v1",
  });
  await providersDb.createProviderNode({
    id: "anthropic-compatible-digi",
    name: "Digi Route Anthropic",
    prefix: "digi-ant",
    type: "anthropic-compatible",
    baseUrl: "https://digi-route.example.com/v1",
  });
  await providersDb.createProviderNode({
    id: "anthropic-compatible-cc-legacy",
    name: "Legacy CC Node",
    prefix: "legacy-cc",
    type: "anthropic-compatible",
    baseUrl: "https://cc.example.com",
  });

  const res = await providerNodesRoute.GET(new Request("http://localhost/api/provider-nodes"));
  const body = await readJson(res);
  const nodes = body.nodes as Array<{ id: string }>;

  assert.equal(res.status, 200);
  assert.equal(body.bpRouteProviderHardLock, true);
  assert.equal(body.ccCompatibleProviderEnabled, false);
  assert.deepEqual(nodes.map((n) => n.id).sort(), [
    "anthropic-compatible-digi",
    "openai-compatible-chat-digi",
  ]);
});

test("POST /api/provider-nodes allows openai-compatible and anthropic-compatible, blocks CC and vibeproxy", async () => {
  process.env.ENABLE_CC_COMPATIBLE_PROVIDER = "true";

  const okOai = await providerNodesRoute.POST(
    new Request("http://localhost/api/provider-nodes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Digi Route OAI",
        prefix: "digi-oai",
        type: "openai-compatible",
        apiType: "chat",
        baseUrl: "https://digi-route.example.com/v1",
      }),
    })
  );
  assert.equal(okOai.status, 201);

  const okAnt = await providerNodesRoute.POST(
    new Request("http://localhost/api/provider-nodes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Digi Route Anthropic",
        prefix: "digi-ant",
        type: "anthropic-compatible",
        baseUrl: "https://digi-route.example.com/v1",
      }),
    })
  );
  assert.equal(okAnt.status, 201);

  const blockedCc = await providerNodesRoute.POST(
    new Request("http://localhost/api/provider-nodes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "CC Blocked",
        prefix: "cc-blocked",
        type: "anthropic-compatible",
        compatMode: "cc",
        baseUrl: "https://cc.example.com",
      }),
    })
  );
  assert.equal(blockedCc.status, 403);
  assert.equal((await readJson(blockedCc)).code, "BP_ROUTE_PROVIDER_LOCKED");

  const blockedVibe = await providerNodesRoute.POST(
    new Request("http://localhost/api/provider-nodes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        preset: "vibeproxy-openai",
        baseUrl: "http://127.0.0.1:8317/v1",
      }),
    })
  );
  assert.equal(blockedVibe.status, 403);
  assert.equal((await readJson(blockedVibe)).code, "BP_ROUTE_PROVIDER_LOCKED");
});

test("POST /api/provider-nodes/validate blocks CC compatMode when hard-lock is active", async () => {
  process.env.ENABLE_CC_COMPATIBLE_PROVIDER = "true";

  const req = await makeManagementSessionRequest("http://localhost/api/provider-nodes/validate", {
    method: "POST",
    body: {
      type: "anthropic-compatible",
      compatMode: "cc",
      baseUrl: "https://cc.example.com",
      apiKey: "sk-test",
    },
  });

  const res = await providerNodesValidateRoute.POST(req);
  assert.equal(res.status, 403);
  assert.equal((await readJson(res)).code, "BP_ROUTE_PROVIDER_LOCKED");
});

test("POST /api/providers blocks built-in/alias/CC providers and allows compatible + ce_ endpoints", async () => {
  for (const blockedProvider of ["openai", "anthropic", "deepseek", "cx", "synthetic", "qoder"]) {
    const res = await providersRoute.POST(
      await makeManagementSessionRequest("http://localhost/api/providers", {
        method: "POST",
        body: {
          provider: blockedProvider,
          name: `Blocked ${blockedProvider}`,
          apiKey: "sk-test-1234",
        },
      })
    );
    assert.equal(res.status, 403, `${blockedProvider} must be blocked`);
    assert.equal((await readJson(res)).code, "BP_ROUTE_PROVIDER_LOCKED");
  }

  await providersDb.createProviderNode({
    id: "openai-compatible-chat-digi1",
    name: "Digi OpenAI",
    prefix: "digi-oai",
    type: "openai-compatible",
    apiType: "chat",
    baseUrl: "https://digi-route.example.com/v1",
  });
  await providersDb.createProviderNode({
    id: "anthropic-compatible-digi1",
    name: "Digi Anthropic",
    prefix: "digi-ant",
    type: "anthropic-compatible",
    baseUrl: "https://digi-route.example.com/v1",
  });
  await providersDb.createProviderNode({
    id: "ce_1234567890abcdef",
    name: "Managed Custom Endpoint",
    prefix: "ce_1234567890abcdef",
    type: "openai-compatible",
    apiType: "openai-compatible",
    baseUrl: "https://digi-route.example.com/v1",
  });

  for (const allowedProvider of [
    "openai-compatible-chat-digi1",
    "anthropic-compatible-digi1",
    "ce_1234567890abcdef",
  ]) {
    const res = await providersRoute.POST(
      await makeManagementSessionRequest("http://localhost/api/providers", {
        method: "POST",
        body: {
          provider: allowedProvider,
          name: `Allowed ${allowedProvider}`,
          apiKey: "sk-digi-1234",
        },
      })
    );
    assert.equal(res.status, 201, `${allowedProvider} must be allowed`);
  }
});

test("GET /api/providers and /api/providers/client hide legacy built-in connections when hard-locked", async () => {
  await providersDb.createProviderNode({
    id: "openai-compatible-chat-digi1",
    name: "Digi OpenAI",
    prefix: "digi-oai",
    type: "openai-compatible",
    apiType: "chat",
    baseUrl: "https://digi-route.example.com/v1",
  });
  await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "Legacy Built-In OpenAI",
    apiKey: "sk-legacy",
    isActive: true,
  });
  await providersDb.createProviderConnection({
    provider: "openai-compatible-chat-digi1",
    authType: "apikey",
    name: "Digi Route Connection",
    apiKey: "sk-digi",
    isActive: true,
  });

  const listRes = await providersRoute.GET(
    await makeManagementSessionRequest("http://localhost/api/providers")
  );
  assert.equal(listRes.status, 200);
  const listBody = await readJson(listRes);
  const listConnections = listBody.connections as Array<{ provider: string }>;
  assert.deepEqual(
    listConnections.map((c) => c.provider),
    ["openai-compatible-chat-digi1"]
  );
  assert.equal(listBody.total, 1);

  const clientRes = await providersClientRoute.GET();
  assert.equal(clientRes.status, 200);
  const clientBody = await readJson(clientRes);
  const clientConnections = clientBody.connections as Array<{ provider: string }>;
  assert.deepEqual(
    clientConnections.map((c) => c.provider),
    ["openai-compatible-chat-digi1"]
  );
});

test("PUT/PATCH/test on legacy built-in provider connections are blocked by hard-lock", async () => {
  const legacyConn = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "Legacy OpenAI",
    apiKey: "sk-legacy",
    isActive: false,
  });

  const putRes = await providerByIdRoute.PUT(
    await makeManagementSessionRequest(`http://localhost/api/providers/${legacyConn.id}`, {
      method: "PUT",
      body: { isActive: true, name: "Attempt Reactivate" },
    }),
    { params: Promise.resolve({ id: String(legacyConn.id) }) }
  );
  assert.equal(putRes.status, 403);
  assert.equal((await readJson(putRes)).code, "BP_ROUTE_PROVIDER_LOCKED");

  const patchRes = await providersRoute.PATCH(
    await makeManagementSessionRequest("http://localhost/api/providers", {
      method: "PATCH",
      body: { ids: [String(legacyConn.id)], isActive: true },
    })
  );
  assert.equal(patchRes.status, 403);
  assert.equal((await readJson(patchRes)).code, "BP_ROUTE_PROVIDER_LOCKED");

  const testRes = await providerTestRoute.POST(
    await makeManagementSessionRequest(`http://localhost/api/providers/${legacyConn.id}/test`, {
      method: "POST",
      body: {},
    }),
    { params: Promise.resolve({ id: String(legacyConn.id) }) }
  );
  assert.equal(testRes.status, 403);
  assert.equal((await readJson(testRes)).code, "BP_ROUTE_PROVIDER_LOCKED");
});

test("bulk, import, validate, test-batch, free-onboarding, and oauth reject built-in providers", async () => {
  const bulkRes = await providersBulkRoute.POST(
    await makeManagementSessionRequest("http://localhost/api/providers/bulk", {
      method: "POST",
      body: {
        provider: "openai",
        entries: [{ name: "k1", apiKey: "sk-1" }],
      },
    })
  );
  assert.equal(bulkRes.status, 403);
  assert.equal((await readJson(bulkRes)).code, "BP_ROUTE_PROVIDER_LOCKED");

  const validateRes = await providersValidateRoute.POST(
    await makeManagementSessionRequest("http://localhost/api/providers/validate", {
      method: "POST",
      body: { provider: "openai", apiKey: "sk-1" },
    })
  );
  assert.equal(validateRes.status, 403);
  assert.equal((await readJson(validateRes)).code, "BP_ROUTE_PROVIDER_LOCKED");

  const importRes = await providersImportRoute.POST(
    await makeManagementSessionRequest("http://localhost/api/providers/import", {
      method: "POST",
      body: {
        entries: [{ provider: "openai", name: "OpenAI Imported", apiKey: "sk-1" }],
        validateKeys: false,
      },
    })
  );
  assert.equal(importRes.status, 200);
  const importBody = await readJson(importRes);
  assert.equal(importBody.success, 0);
  assert.equal(importBody.failed, 1);

  const testBatchRes = await providersTestBatchRoute.POST(
    await makeManagementSessionRequest("http://localhost/api/providers/test-batch", {
      method: "POST",
      body: { mode: "oauth" },
    })
  );
  assert.equal(testBatchRes.status, 403);
  assert.equal((await readJson(testBatchRes)).code, "BP_ROUTE_PROVIDER_LOCKED");

  const freeGetRes = await providersFreeOnboardingRoute.GET(
    await makeManagementSessionRequest("http://localhost/api/providers/free-onboarding")
  );
  assert.equal(freeGetRes.status, 200);
  assert.deepEqual(await readJson(freeGetRes), { providers: [], bpRouteProviderHardLock: true });

  const freePostRes = await providersFreeOnboardingRoute.POST(
    await makeManagementSessionRequest("http://localhost/api/providers/free-onboarding", {
      method: "POST",
      body: { providerIds: ["opencode"], confirmed: true },
    })
  );
  assert.equal(freePostRes.status, 403);
  assert.equal((await readJson(freePostRes)).code, "BP_ROUTE_PROVIDER_LOCKED");

  const oauthRes = await oauthActionRoute.GET(
    await makeManagementSessionRequest("http://localhost/api/oauth/claude/authorize"),
    { params: Promise.resolve({ provider: "claude", action: "authorize" }) }
  );
  assert.equal(oauthRes.status, 403);
  assert.equal((await readJson(oauthRes)).code, "BP_ROUTE_PROVIDER_LOCKED");

  const settingsRes = await settingsRoute.GET(
    await makeManagementSessionRequest("http://localhost/api/settings")
  );
  assert.equal(settingsRes.status, 200);
  assert.equal((await readJson(settingsRes)).bpRouteProviderHardLock, true);
});
