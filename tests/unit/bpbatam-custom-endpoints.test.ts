import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

const pair = await generateKeyPair("RS256");
const jwk = {
  ...(await exportJWK(pair.publicKey)),
  kid: "test-custom-endpoints-key",
  alg: "RS256",
};
const oidcServer = http.createServer((_req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ keys: [jwk] }));
});

const { promise: oidcListening, resolve: resolveOidcListening } = Promise.withResolvers<void>();
oidcServer.listen(0, "127.0.0.1", () => resolveOidcListening());
await oidcListening;

const oidcAddress = oidcServer.address() as AddressInfo;
const oidcIssuer = `http://127.0.0.1:${oidcAddress.port}`;
process.env.BPBATAM_OIDC_ISSUER = oidcIssuer;
process.env.BPBATAM_SERVICE_AUDIENCE = "custom-endpoints-tests";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bp-custom-endpoints-"));
process.env.DATA_DIR = directory;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.API_KEY_SECRET = "synthetic-custom-endpoints-secret-key-12345";
process.env.STORAGE_ENCRYPTION_KEY = "synthetic-storage-key-12345678901234567890";
// Dynamic import required here: DATA_DIR and encryption secrets must be configured in process.env before database core modules evaluate.
const core = await import("../../src/lib/db/core.ts");
const wallet = await import("../../src/lib/db/bpbatam.ts");
const keys = await import("../../src/lib/db/apiKeys.ts");
const offers = await import("../../src/lib/bpbatam/offers.ts");
const customEndpoints = await import("../../src/lib/db/bpbatamCustomEndpoints.ts");
const transport = await import("../../src/lib/bpbatam/customTransport.ts");
const bridgeRoute = await import("../../src/app/api/bpbatam/custom-endpoints/route.ts");
const bridgeSlugRoute =
  await import("../../src/app/api/bpbatam/custom-endpoints/[...slug]/route.ts");
const { governedInference } = await import("../../src/lib/bpbatam/inference.ts");
const { recordGovernedDispatch, recordGovernedUsage } =
  await import("../../src/lib/bpbatam/context.ts");
const chatRoute = await import("../../src/app/api/v1/chat/completions/route.ts");

const subject = "custom-endpoint-test-user";
const apiKey = await keys.createApiKey(subject, "unit-test");
wallet.createAccount("root", null, "platform");
wallet.createAccount(subject, "root", "user");
wallet.bindPrincipal(subject, "issuer", subject, apiKey.id);

async function flushAsyncSideEffects(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test.after(async () => {
  await flushAsyncSideEffects();
  core.resetDbInstance();
  oidcServer.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("custom endpoint creation encrypts API key at rest and exposes key_configured without leaking plaintext", () => {
  const endpoint = customEndpoints.createCustomEndpoint({
    name: "Secure Endpoint",
    base_url: "https://api.secure-llm.example.com/v1",
    enabled: true,
    api_key: "sk-super-secret-key-999",
  });

  assert.equal(endpoint.name, "Secure Endpoint");
  assert.equal(endpoint.base_url, "https://api.secure-llm.example.com/v1");
  assert.equal(endpoint.enabled, true);
  assert.equal(endpoint.key_configured, true);
  // Ensure DTO has no api_key property
  assert.equal("api_key" in endpoint, false);

  // Inspect raw database row to verify ciphertext
  const db = core.getDbInstance();
  const row = db
    .prepare("SELECT api_key_ciphertext FROM bp_custom_endpoints WHERE id = ?")
    .get(endpoint.id) as { api_key_ciphertext: string };
  assert.ok(row.api_key_ciphertext);
  assert.notEqual(row.api_key_ciphertext, "sk-super-secret-key-999");
  assert.match(row.api_key_ciphertext, /^enc:v1:/);

  // Decryption recovers the key
  const decrypted = customEndpoints.getDecryptedEndpointApiKey(endpoint.id);
  assert.equal(decrypted, "sk-super-secret-key-999");

  // Updating without api_key preserves existing ciphertext
  const updated1 = customEndpoints.updateCustomEndpoint(endpoint.id, {
    name: "Renamed Endpoint",
  });
  assert.equal(updated1?.name, "Renamed Endpoint");
  assert.equal(updated1?.key_configured, true);
  assert.equal(customEndpoints.getDecryptedEndpointApiKey(endpoint.id), "sk-super-secret-key-999");

  // Updating with null or empty string clears key
  const updated2 = customEndpoints.updateCustomEndpoint(endpoint.id, {
    api_key: "",
  });
  assert.equal(updated2?.key_configured, false);
  assert.equal(customEndpoints.getDecryptedEndpointApiKey(endpoint.id), null);
});

test("two different endpoints can share identical upstream_id and produce distinct stable offers", async () => {
  const ep1 = customEndpoints.createCustomEndpoint({
    name: "Provider Alpha",
    base_url: "https://alpha.example.com/v1",
  });
  const ep2 = customEndpoints.createCustomEndpoint({
    name: "Provider Beta",
    base_url: "https://beta.example.com/v1",
  });

  const m1 = customEndpoints.createCustomEndpointModel(ep1.id, {
    upstream_id: "llama-3-70b",
    name: "Alpha Llama",
    quota_enabled: true,
  });
  const m2 = customEndpoints.createCustomEndpointModel(ep2.id, {
    upstream_id: "llama-3-70b",
    name: "Beta Llama",
    quota_enabled: false,
  });

  assert.equal(m1.id, `${ep1.id}/llama-3-70b`);
  assert.equal(m2.id, `${ep2.id}/llama-3-70b`);
  assert.notEqual(m1.id, m2.id);

  const published = await offers.publishedOffers();
  const offer1 = published.find((o) => o.id === m1.id);
  const offer2 = published.find((o) => o.id === m2.id);

  assert.ok(offer1, "ep1 model must be published");
  assert.ok(offer2, "ep2 model must be published");
  assert.deepEqual(offer1.targets, [m1.id]);
  assert.deepEqual(offer2.targets, [m2.id]);
  assert.notEqual(offer1.version, offer2.version);

  // Quota exemption contract: m1 is quota-enabled, m2 is quota-exempt
  assert.equal(customEndpoints.isCustomModelQuotaExempt(m1.id), false);
  assert.equal(customEndpoints.isCustomModelQuotaExempt(m2.id), true);
});

test("disabling endpoint removes offer from catalog and suspends access; re-enabling restores identical offer and assignment", async () => {
  const ep = customEndpoints.createCustomEndpoint({
    name: "Lifecycle Endpoint",
    base_url: "https://lifecycle.example.com/v1",
    enabled: true,
  });

  const model = customEndpoints.createCustomEndpointModel(ep.id, {
    upstream_id: "qwen-2.5",
    name: "Qwen 2.5",
  });

  const publishedBefore = await offers.publishedOffers();
  const initialOffer = publishedBefore.find((o) => o.id === model.id);
  assert.ok(initialOffer);

  // Assign offer to user
  wallet.setOffers(subject, [initialOffer]);
  const policyBefore = await offers.managedPolicy(apiKey.id, "/v1/chat/completions", model.id);
  assert.equal(policyBefore, null, "access must be granted when endpoint and model are active");

  // Disable the endpoint
  customEndpoints.updateCustomEndpoint(ep.id, { enabled: false });

  const publishedWhileDisabled = await offers.publishedOffers();
  assert.equal(
    publishedWhileDisabled.some((o) => o.id === model.id),
    false,
    "model offer must NOT be published while endpoint is disabled"
  );

  // In-flight access check fails closed
  const policyWhileDisabled = await offers.managedPolicy(
    apiKey.id,
    "/v1/chat/completions",
    model.id
  );
  assert.ok(policyWhileDisabled);
  assert.equal(policyWhileDisabled.status, 409);

  // Re-enable endpoint: offer is published again with exact same hash
  customEndpoints.updateCustomEndpoint(ep.id, { enabled: true });

  const publishedAfterReenable = await offers.publishedOffers();
  const restoredOffer = publishedAfterReenable.find((o) => o.id === model.id);
  assert.ok(restoredOffer);
  assert.equal(
    restoredOffer.version,
    initialOffer.version,
    "restored offer must preserve exact scope and version hash"
  );

  // User assignment was preserved and works immediately without re-assigning
  const policyAfterReenable = await offers.managedPolicy(
    apiKey.id,
    "/v1/chat/completions",
    model.id
  );
  assert.equal(policyAfterReenable, null, "assignment must be restored on re-activation");

  // Now test disabling just the model
  customEndpoints.updateCustomEndpointModel(ep.id, model.id, { enabled: false });
  const publishedWhileModelDisabled = await offers.publishedOffers();
  assert.equal(
    publishedWhileModelDisabled.some((o) => o.id === model.id),
    false
  );
  const policyModelDisabled = await offers.managedPolicy(
    apiKey.id,
    "/v1/chat/completions",
    model.id
  );
  assert.ok(policyModelDisabled);

  // Re-enable model
  customEndpoints.updateCustomEndpointModel(ep.id, model.id, { enabled: true });
  const policyModelRestored = await offers.managedPolicy(
    apiKey.id,
    "/v1/chat/completions",
    model.id
  );
  assert.equal(policyModelRestored, null);
});

test("safe transport rejects cloud metadata and redirects during validation and synthetic testing", async () => {
  // Cloud metadata hosts blocked during URL validation
  assert.throws(
    () => transport.validateCustomEndpointUrl("http://169.254.169.254/v1"),
    /METADATA_ADDRESS_DENIED/
  );
  assert.throws(
    () => transport.validateCustomEndpointUrl("http://metadata.google.internal/v1"),
    /METADATA_ADDRESS_DENIED/
  );
  assert.throws(
    () => transport.validateCustomEndpointUrl("ftp://custom.internal/v1"),
    /INVALID_PROTOCOL/
  );

  // Start local mock HTTP server to test synthetic connection test & redirect denial
  const { promise: serverReady, resolve: resolveReady } = Promise.withResolvers<number>();
  let successCount = 0;

  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/redirect")) {
      res.writeHead(302, { Location: "/chat/completions" });
      res.end();
      return;
    }
    if (req.url?.includes("/chat/completions")) {
      successCount++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-test",
          choices: [{ message: { role: "assistant", content: "pong" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    resolveReady(typeof address === "object" && address ? address.port : 0);
  });

  const port = await serverReady;

  try {
    // 1. Successful synthetic test
    const successResult = await transport.testCustomEndpointModel(
      `http://127.0.0.1:${port}/v1`,
      "mock-model",
      "mock-key"
    );
    assert.equal(successResult.ok, true);
    assert.ok(typeof successResult.latency_ms === "number");
    assert.ok(successCount > 0);

    // 2. Redirect denial
    const redirectResult = await transport.testCustomEndpointModel(
      `http://127.0.0.1:${port}/redirect`,
      "mock-model",
      "mock-key"
    );
    assert.equal(redirectResult.ok, false);
    assert.match(redirectResult.error ?? "", /REDIRECT_DENIED/);
  } finally {
    server.close();
  }
});
test("upstream IDs containing slashes produce stable IDs and survive display name changes", async () => {
  const ep = customEndpoints.createCustomEndpoint({
    name: "HuggingFace Endpoint",
    base_url: "https://hf.example.com/v1",
    enabled: true,
  });

  const model = customEndpoints.createCustomEndpointModel(ep.id, {
    upstream_id: "meta-llama/Llama-3-70b-Instruct",
    name: "Llama 3 70B Instruct",
    quota_enabled: true,
  });

  assert.equal(model.id, `${ep.id}/meta-llama/Llama-3-70b-Instruct`);
  assert.equal(model.upstream_id, "meta-llama/Llama-3-70b-Instruct");

  const publishedBefore = await offers.publishedOffers();
  const initialOffer = publishedBefore.find((o) => o.id === model.id);
  assert.ok(initialOffer);
  assert.deepEqual(initialOffer.targets, [model.id]);

  // Changing display name must NOT alter the model ID or offer version
  const updated = customEndpoints.updateCustomEndpointModel(ep.id, encodeURIComponent(model.id), {
    name: "Renamed Llama 3",
  });
  assert.equal(updated?.name, "Renamed Llama 3");
  assert.equal(updated?.id, model.id);
  assert.equal(updated?.upstream_id, "meta-llama/Llama-3-70b-Instruct");

  const publishedAfter = await offers.publishedOffers();
  const afterOffer = publishedAfter.find((o) => o.id === model.id);
  assert.ok(afterOffer);
  assert.equal(
    afterOffer.version,
    initialOffer.version,
    "display name change must preserve catalog identity and offer version"
  );

  // Model lookup by raw slash-containing upstream_id or full ID
  assert.equal(customEndpoints.isCustomModelQuotaExempt(model.id), false);
  const info = customEndpoints.getCustomModelInfo(model.id);
  assert.equal(info?.upstreamId, "meta-llama/Llama-3-70b-Instruct");
  assert.equal(info?.endpointId, ep.id);
});
test("bridge HTTP routes handle CRUD, authorization, and slash-containing model IDs via encoded paths", async () => {
  const makeToken = async (roles = ["bp:config.manage", "bp:read", "bp:write"]) =>
    new SignJWT({ azp: "control-panel", realm_access: { roles } })
      .setProtectedHeader({ alg: "RS256", kid: "test-custom-endpoints-key" })
      .setIssuer(oidcIssuer)
      .setAudience("custom-endpoints-tests")
      .setSubject("admin-subject")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(pair.privateKey);

  // Unauth check
  const unauth = await bridgeRoute.GET(
    new Request("http://localhost/api/bpbatam/custom-endpoints")
  );
  assert.equal(unauth.status, 401);

  const token = await makeToken();
  const authHeaders = { Authorization: "Bearer " + token, "Content-Type": "application/json" };

  // 1. POST /api/bpbatam/custom-endpoints
  const createRes = await bridgeRoute.POST(
    new Request("http://localhost/api/bpbatam/custom-endpoints", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        name: "Route Test Provider",
        base_url: "https://router-provider.example.com/v1",
        api_key: "sk-route-secret",
      }),
    })
  );
  assert.equal(createRes.status, 201);
  const createdEp = (await createRes.json()) as customEndpoints.CustomEndpointDto;
  assert.equal(createdEp.name, "Route Test Provider");
  assert.equal(createdEp.key_configured, true);
  assert.equal("api_key" in createdEp, false);

  // 2. GET /api/bpbatam/custom-endpoints
  const getRes = await bridgeRoute.GET(
    new Request("http://localhost/api/bpbatam/custom-endpoints", {
      headers: { Authorization: "Bearer " + token },
    })
  );
  assert.equal(getRes.status, 200);
  const list = (await getRes.json()) as customEndpoints.CustomEndpointDto[];
  assert.ok(list.some((e) => e.id === createdEp.id));

  // 3. POST /api/bpbatam/custom-endpoints/{id}/models with upstream slash
  const createModelRes = await bridgeSlugRoute.POST(
    new Request(`http://localhost/api/bpbatam/custom-endpoints/${createdEp.id}/models`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        upstream_id: "deepseek-ai/DeepSeek-V3",
        name: "DeepSeek V3 Model",
        quota_enabled: true,
      }),
    }),
    { params: Promise.resolve({ slug: [createdEp.id, "models"] }) }
  );
  assert.equal(createModelRes.status, 201);
  const createdModel = (await createModelRes.json()) as customEndpoints.CustomModelDto;
  assert.equal(createdModel.upstream_id, "deepseek-ai/DeepSeek-V3");
  assert.equal(createdModel.id, `${createdEp.id}/deepseek-ai/DeepSeek-V3`);

  // 4. PUT /api/bpbatam/custom-endpoints/{id}/models/{model_id} with URL-encoded slash
  const encodedModelId = encodeURIComponent(createdModel.id);
  const updateModelRes = await bridgeSlugRoute.PUT(
    new Request(
      `http://localhost/api/bpbatam/custom-endpoints/${createdEp.id}/models/${encodedModelId}`,
      {
        method: "PUT",
        headers: authHeaders,
        body: JSON.stringify({
          name: "DeepSeek V3 Updated Name",
          quota_enabled: false,
        }),
      }
    ),
    { params: Promise.resolve({ slug: [createdEp.id, "models", encodedModelId] }) }
  );
  assert.equal(updateModelRes.status, 200);
  const updatedModel = (await updateModelRes.json()) as customEndpoints.CustomModelDto;
  assert.equal(updatedModel.name, "DeepSeek V3 Updated Name");
  assert.equal(updatedModel.quota_enabled, false);
  assert.equal(updatedModel.id, createdModel.id);

  // 5. POST test connection with URL-encoded slash
  const testRes = await bridgeSlugRoute.POST(
    new Request(
      `http://localhost/api/bpbatam/custom-endpoints/${createdEp.id}/models/${encodedModelId}/test`,
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({}),
      }
    ),
    { params: Promise.resolve({ slug: [createdEp.id, "models", encodedModelId, "test"] }) }
  );
  assert.equal(testRes.status, 200);
  const testResult = (await testRes.json()) as { ok: boolean };
  assert.equal(typeof testResult.ok, "boolean");
});

test("published custom model offer admits through governed chat dispatch and rejects when disabled", async () => {
  const ep = customEndpoints.createCustomEndpoint({
    name: "Chat Dispatch Provider",
    base_url: "https://chat-provider.example.com/v1",
    enabled: true,
  });
  const model = customEndpoints.createCustomEndpointModel(ep.id, {
    upstream_id: "meta-llama/Llama-3.3-70B",
    name: "Llama 3.3 70B",
    quota_enabled: true,
  });

  const chatUser = "chat-dispatch-user";
  const userKey = await keys.createApiKey(chatUser, "unit-test");
  wallet.createAccount(chatUser, "root", "user");
  wallet.allocate("grant-chat-dispatch", null, chatUser, 100000, "issuer");
  wallet.bindPrincipal(chatUser, "issuer", chatUser, userKey.id);

  const publishedOffers = await offers.publishedOffers();
  const targetOffer = publishedOffers.find((o) => o.id === model.id);
  assert.ok(targetOffer);
  wallet.setOffers(chatUser, [targetOffer]);

  // 1. Admitted request through governedInference
  let dispatched = false;
  const admittedRes = await governedInference(
    new Request("http://router.test/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + userKey.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model.id,
        messages: [{ role: "user", content: "Hello custom model" }],
        max_tokens: 100,
        stream: false,
      }),
    }),
    async () => {
      dispatched = true;
      recordGovernedDispatch();
      recordGovernedUsage({ prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 });
      return Response.json({
        id: "chatcmpl-custom-1",
        choices: [{ message: { role: "assistant", content: "Hi there!" } }],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      });
    }
  );

  assert.equal(admittedRes.status, 200);
  assert.equal(dispatched, true);
  const receipt = admittedRes.headers.get("x-bpbatam-receipt");
  assert.ok(receipt);
  assert.equal(wallet.admission(receipt)?.state, "settled");

  // 2. Disable endpoint: subsequent chat dispatch MUST be rejected with 409 OFFER_VERSION_CHANGED
  customEndpoints.updateCustomEndpoint(ep.id, { enabled: false });

  let secondDispatched = false;
  const rejectedRes = await governedInference(
    new Request("http://router.test/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + userKey.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model.id,
        messages: [{ role: "user", content: "Hello again" }],
        max_tokens: 100,
        stream: false,
      }),
    }),
    async () => {
      secondDispatched = true;
      return Response.json({ ok: true });
    }
  );

  assert.equal(rejectedRes.status, 409);
  assert.equal(
    secondDispatched,
    false,
    "upstream dispatch must NOT be called when model is disabled"
  );

  // 3. Re-enable endpoint: chat dispatch succeeds again immediately
  customEndpoints.updateCustomEndpoint(ep.id, { enabled: true });

  let thirdDispatched = false;
  const reenabledRes = await governedInference(
    new Request("http://router.test/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + userKey.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model.id,
        messages: [{ role: "user", content: "Back online" }],
        max_tokens: 100,
        stream: false,
      }),
    }),
    async () => {
      thirdDispatched = true;
      recordGovernedDispatch();
      recordGovernedUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
      return Response.json({ choices: [{ message: { content: "I am back!" } }] });
    }
  );

  assert.equal(reenabledRes.status, 200);
  assert.equal(thirdDispatched, true);
});
test("auto-generated managed combo is published, recognized as quota-exempt, allows zero-balance access, and restores on reactivate", async () => {
  const ep = customEndpoints.createCustomEndpoint({
    name: "Zero Balance Provider",
    base_url: "https://zero-bal.example.com/v1",
    enabled: true,
  });
  const model = customEndpoints.createCustomEndpointModel(ep.id, {
    upstream_id: "mistralai/Mistral-Small",
    name: "Mistral Small (Quota Off)",
    quota_enabled: false,
  });

  const autoComboId = "combo/" + model.id;

  // 1. Verify auto-generated managed combo is published with kind='combo' and distinct ID
  const catalog = await offers.publishedOffers();
  const modelOffer = catalog.find((o) => o.id === model.id);
  const comboOffer = catalog.find((o) => o.id === autoComboId);

  assert.ok(modelOffer, "raw model offer must be published");
  assert.equal(modelOffer.kind, "model");

  assert.ok(comboOffer, "auto-generated single-target combo offer must be published");
  assert.equal(comboOffer.kind, "combo");
  assert.deepEqual(comboOffer.targets, [model.id]);
  assert.notEqual(comboOffer.id, modelOffer.id);

  // 2. Control Panel with model_catalog_combos_only: True filters out kind='model'
  // Verify the custom model remains available through its auto-generated combo
  const combosOnlyCatalog = catalog.filter((o) => o.kind === "combo");
  assert.ok(
    combosOnlyCatalog.some((o) => o.id === autoComboId),
    "custom model combo must be visible in combos-only catalog"
  );

  // 3. Verify quota exemption lookup recognizes the auto-generated combo ID
  assert.equal(
    customEndpoints.isCustomModelQuotaExempt(autoComboId),
    true,
    "isCustomModelQuotaExempt must recognize combo/<model_id>"
  );
  assert.equal(
    customEndpoints.isCustomModelQuotaExempt(model.id),
    true,
    "isCustomModelQuotaExempt must recognize bare model_id"
  );

  // 4. Zero-balance user: account created with balance 0 (NO allocation grant)
  const zeroUser = "zero-bal-user-1";
  wallet.createAccount(zeroUser, "root", "user");
  const initialAccount = wallet.account(zeroUser);
  assert.equal(initialAccount?.balance, 0);
  assert.equal(initialAccount?.reserved, 0);

  const zeroKey = await keys.createApiKey(zeroUser, "unit-test");
  wallet.bindPrincipal(zeroUser, "issuer", zeroUser, zeroKey.id);
  wallet.setOffers(zeroUser, [comboOffer]);

  // 5. Governed chat dispatch through the auto-generated combo succeeds with ZERO balance
  let dispatched = false;
  const res = await governedInference(
    new Request("http://router.test/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + zeroKey.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: autoComboId,
        messages: [{ role: "user", content: "Zero balance prompt" }],
        max_tokens: 150,
        stream: false,
      }),
    }),
    async () => {
      dispatched = true;
      recordGovernedDispatch();
      recordGovernedUsage({ prompt_tokens: 25, completion_tokens: 15, total_tokens: 40 });
      return Response.json({
        id: "chatcmpl-zero-bal",
        choices: [{ message: { role: "assistant", content: "Quota-free reply" } }],
        usage: { prompt_tokens: 25, completion_tokens: 15, total_tokens: 40 },
      });
    }
  );

  assert.equal(res.status, 200);
  assert.equal(dispatched, true);
  const receipt = res.headers.get("x-bpbatam-receipt");
  assert.ok(receipt);

  // Verified: zero balance is NOT deducted, usage IS recorded
  const finalAccount = wallet.account(zeroUser);
  assert.equal(finalAccount?.balance, 0);
  assert.equal(finalAccount?.reserved, 0);
  const admissionRow = wallet.admission(receipt);
  assert.equal(admissionRow?.state, "settled");
  assert.equal(admissionRow?.actual, 40);

  // 6. Disable endpoint suspends access; re-enabling restores assignment and access
  customEndpoints.updateCustomEndpoint(ep.id, { enabled: false });
  const catalogDisabled = await offers.publishedOffers();
  assert.equal(
    catalogDisabled.some((o) => o.id === autoComboId),
    false
  );

  const suspendedRes = await governedInference(
    new Request("http://router.test/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + zeroKey.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: autoComboId,
        messages: [{ role: "user", content: "While disabled" }],
      }),
    }),
    async () => Response.json({ ok: true })
  );
  assert.equal(suspendedRes.status, 409);

  // Re-enable restores the combo offer with exact same version and recovers user access
  customEndpoints.updateCustomEndpoint(ep.id, { enabled: true });
  const catalogRestored = await offers.publishedOffers();
  const restoredCombo = catalogRestored.find((o) => o.id === autoComboId);
  assert.ok(restoredCombo);
  assert.equal(restoredCombo.version, comboOffer.version);

  let reenabledDispatched = false;
  const restoredRes = await governedInference(
    new Request("http://router.test/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + zeroKey.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: autoComboId,
        messages: [{ role: "user", content: "After reactivation" }],
        max_tokens: 50,
      }),
    }),
    async () => {
      reenabledDispatched = true;
      recordGovernedDispatch();
      recordGovernedUsage({ prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 });
      return Response.json({ choices: [{ message: { content: "Restored!" } }] });
    }
  );
  assert.equal(restoredRes.status, 200);
  assert.equal(reenabledDispatched, true);
});
test("real chat completions route dispatches end-to-end to local synthetic HTTP upstream with OpenAI-compatible body and key", async () => {
  let receivedAuth = "";
  let receivedModel = "";
  let receivedMessages: Array<{ role?: string; content?: string }> = [];
  let streamCount = 0;
  let nonStreamCount = 0;

  const upstreamServer = http.createServer((req, res) => {
    receivedAuth = req.headers["authorization"] || "";
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(data);
        if (parsed && typeof parsed === "object") body = parsed;
      } catch {}
      receivedModel = typeof body.model === "string" ? body.model : "";
      receivedMessages = Array.isArray(body.messages) ? body.messages : [];

      if (body.stream) {
        streamCount++;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(
          'data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant","content":"Live stream"}}]}\n\n'
        );
        res.write(
          'data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n'
        );
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        nonStreamCount++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-real-123",
            object: "chat.completion",
            created: Date.now(),
            model: body.model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Response from real upstream" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          })
        );
      }
    });
  });

  const { promise: upstreamReady, resolve: resolveUpstreamReady } = Promise.withResolvers<number>();
  upstreamServer.listen(0, "127.0.0.1", () => {
    const address = upstreamServer.address();
    resolveUpstreamReady(typeof address === "object" && address ? address.port : 0);
  });
  const port = await upstreamReady;

  try {
    const ep = customEndpoints.createCustomEndpoint({
      name: "Live Upstream Server",
      base_url: `http://127.0.0.1:${port}/v1`,
      enabled: true,
      api_key: "sk-upstream-secret-xyz",
    });
    const model = customEndpoints.createCustomEndpointModel(ep.id, {
      upstream_id: "synthetic-llama-model",
      name: "Synthetic Llama",
      quota_enabled: true,
    });

    const chatSubject = "real-chat-user";
    const userKey = await keys.createApiKey(chatSubject, "unit-test");
    wallet.createAccount(chatSubject, "root", "user");
    wallet.allocate("grant-real-chat", null, chatSubject, 100000, "issuer");
    wallet.bindPrincipal(chatSubject, "issuer", chatSubject, userKey.id);

    const published = await offers.publishedOffers();
    const offer = published.find((o) => o.id === model.id);
    assert.ok(offer);
    wallet.setOffers(chatSubject, [offer]);

    // 1. Non-streaming request through real chat completions route
    const nonStreamRequest = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + userKey.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model.id,
        messages: [{ role: "user", content: "Ping real upstream" }],
        stream: false,
        max_tokens: 100,
      }),
    });

    const nonStreamResponse = await chatRoute.POST(nonStreamRequest);
    assert.equal(nonStreamResponse.status, 200);
    assert.equal(nonStreamCount, 1);
    assert.equal(receivedAuth, "Bearer sk-upstream-secret-xyz");
    assert.equal(receivedModel, "synthetic-llama-model");
    assert.equal(receivedMessages[0]?.content, "Ping real upstream");

    const receipt = nonStreamResponse.headers.get("x-bpbatam-receipt");
    assert.ok(receipt);
    assert.equal(wallet.admission(receipt)?.state, "settled");

    // 2. Streaming request through real chat completions route
    const streamRequest = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + userKey.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model.id,
        messages: [{ role: "user", content: "Stream real upstream" }],
        stream: true,
        max_tokens: 100,
      }),
    });

    const streamResponse = await chatRoute.POST(streamRequest);
    assert.equal(streamResponse.status, 200);
    assert.equal(streamCount, 1);
    assert.equal(streamResponse.headers.get("content-type")?.includes("text/event-stream"), true);

    // 3. Real route dispatch through the auto-managed single-target combo (combo-only path)
    const autoComboId = "combo/" + model.id;
    const comboOffer = published.find((o) => o.id === autoComboId);
    assert.ok(comboOffer, "auto-managed combo offer must be published in catalog");
    assert.equal(comboOffer.kind, "combo");
    assert.deepEqual(comboOffer.targets, [model.id]);

    // Assign ONLY the combo offer to simulate CP model_catalog_combos_only assignment
    wallet.setOffers(chatSubject, [comboOffer]);

    const initialNonStreamCount = nonStreamCount;
    const comboNonStreamRequest = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + userKey.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: autoComboId,
        messages: [{ role: "user", content: "Ping via auto-managed combo" }],
        stream: false,
        max_tokens: 100,
      }),
    });

    const comboResponse = await chatRoute.POST(comboNonStreamRequest);
    assert.equal(comboResponse.status, 200);
    assert.equal(nonStreamCount, initialNonStreamCount + 1);
    assert.equal(receivedAuth, "Bearer sk-upstream-secret-xyz");
    assert.equal(receivedModel, "synthetic-llama-model");
    assert.equal(receivedMessages[0]?.content, "Ping via auto-managed combo");

    const comboReceipt = comboResponse.headers.get("x-bpbatam-receipt");
    assert.ok(comboReceipt);
    assert.equal(wallet.admission(comboReceipt)?.state, "settled");

    // 4. Real route streaming dispatch through the auto-managed combo
    const initialStreamCount = streamCount;
    const comboStreamRequest = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + userKey.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: autoComboId,
        messages: [{ role: "user", content: "Stream via auto-managed combo" }],
        stream: true,
        max_tokens: 100,
      }),
    });

    const comboStreamResponse = await chatRoute.POST(comboStreamRequest);
    assert.equal(comboStreamResponse.status, 200);
    assert.equal(streamCount, initialStreamCount + 1);
    assert.equal(
      comboStreamResponse.headers.get("content-type")?.includes("text/event-stream"),
      true
    );
    const comboStreamReceipt = comboStreamResponse.headers.get("x-bpbatam-receipt");
    assert.ok(comboStreamReceipt);
    assert.equal(wallet.admission(comboStreamReceipt)?.state, "settled");
    // Wait on observable gamification completion for userKey before teardown (bounded, safe if disabled)
    const gamificationDb = await import("../../src/lib/db/gamification.ts");
    for (let i = 0; i < 50; i++) {
      if (gamificationDb.getXp(userKey.id)) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    await flushAsyncSideEffects();
  } finally {
    await flushAsyncSideEffects();
    upstreamServer.close();
  }
});
