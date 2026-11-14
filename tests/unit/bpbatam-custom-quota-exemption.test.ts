import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bp-custom-quota-"));
process.env.DATA_DIR = directory;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.API_KEY_SECRET = "synthetic-custom-quota-unit-test-secret";

const core = await import("../../src/lib/db/core.ts");
const wallet = await import("../../src/lib/db/bpbatam.ts");
const keys = await import("../../src/lib/db/apiKeys.ts");
const customEndpoints = await import("../../src/lib/db/bpbatamCustomEndpoints.ts");
const offers = await import("../../src/lib/bpbatam/offers.ts");
const { governedInference } = await import("../../src/lib/bpbatam/inference.ts");
const { recordGovernedDispatch, recordGovernedUsage } =
  await import("../../src/lib/bpbatam/context.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(directory, { recursive: true, force: true });
});

// Setup root account and custom endpoints
wallet.createAccount("root", null, "platform");

const ep1 = customEndpoints.createCustomEndpoint({
  name: "Test Endpoint 1",
  base_url: "http://127.0.0.1:9099/v1",
  enabled: true,
});

// Model with quota exemption (quota_enabled: false)
const exemptModel = customEndpoints.createCustomEndpointModel(ep1.id, {
  upstream_id: "exempt-chat",
  name: "Exempt Chat Model",
  enabled: true,
  quota_enabled: false,
});

// Model with quota active (quota_enabled: true)
const activeModel = customEndpoints.createCustomEndpointModel(ep1.id, {
  upstream_id: "metered-chat",
  name: "Metered Chat Model",
  enabled: true,
  quota_enabled: true,
});

const combos = await import("../../src/lib/db/combos.ts");

// Register a combo with exempt custom model as sole target (combo-only custom offer)
await combos.createCombo({
  name: "combo-exempt",
  strategy: "priority",
  models: [exemptModel.id],
});

// Register a mixed combo with exempt custom model AND metered active model
await combos.createCombo({
  name: "combo-mixed",
  strategy: "priority",
  models: [exemptModel.id, activeModel.id],
});

let sequence = 0;
async function setupUser(balance = 0) {
  const id = "quota-user-" + ++sequence;
  const key = await keys.createApiKey(id, "unit-test");
  wallet.createAccount(id, "root", "user");
  if (balance > 0) {
    wallet.allocate("grant-" + id, null, id, balance, "issuer");
  }
  wallet.bindPrincipal(id, "issuer", id, key.id);
  wallet.setOffers(id, await offers.publishedOffers());
  return { id, key };
}

test("quota-exempt model admits and settles with recorded actual usage even when user has 0 balance", async () => {
  const { id, key } = await setupUser(0); // 0 balance
  assert.equal(wallet.account(id)?.balance, 0);

  const response = await governedInference(
    new Request("http://router.test/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: exemptModel.id,
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      }),
    }),
    async () => {
      recordGovernedDispatch();
      recordGovernedUsage({ prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 });
      return Response.json({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
      });
    }
  );

  assert.equal(response.status, 200);
  const receipt = response.headers.get("x-bpbatam-receipt");
  assert.ok(receipt);

  const adm = wallet.admission(receipt!);
  assert.equal(adm?.state, "settled");
  assert.equal(adm?.actual, 35);

  const usage = JSON.parse(adm?.usage_json ?? "{}");
  assert.equal(usage.total, 35);
  assert.equal(usage.input, 20);
  assert.equal(usage.output, 15);

  // Snapshot verifies quota_exempt was stored
  const limits = JSON.parse(adm?.limits_json ?? "{}");
  assert.equal(limits.quota_exempt, true);

  // User balance remained 0 (no debit) and reserved remained 0
  assert.equal(wallet.account(id)?.balance, 0);
  assert.equal(wallet.account(id)?.reserved, 0);
});

test("quota-active model rejects user with 0 balance with INSUFFICIENT_TOKENS", async () => {
  const { key } = await setupUser(0); // 0 balance

  // 1. Direct reserve call throws TokenPolicyError("INSUFFICIENT_TOKENS", 429)
  assert.throws(
    () =>
      wallet.reserve(
        "direct-reserve-test",
        key.id,
        500,
        "/v1/chat/completions",
        activeModel.id,
        []
      ),
    { code: "INSUFFICIENT_TOKENS", status: 429 }
  );

  // 2. Governed inference maps rejection to 429 HTTP response
  const response = await governedInference(
    new Request("http://router.test/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: activeModel.id,
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      }),
    }),
    async () => Response.json({ choices: [] })
  );

  assert.equal(response.status, 429);
  const data = await response.json();
  assert.equal(data.error?.message, "INSUFFICIENT_TOKENS");
});

test("quota-exempt model marks missing usage as unknown without triggering uncertain lock", async () => {
  const { key } = await setupUser(0);

  const response = await governedInference(
    new Request("http://router.test/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: exemptModel.id,
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      }),
    }),
    async () => {
      recordGovernedDispatch();
      // No usage reported by upstream provider
      return Response.json({
        choices: [{ message: { content: "ok" } }],
      });
    }
  );

  assert.equal(response.status, 200);
  const receipt = response.headers.get("x-bpbatam-receipt")!;
  const adm = wallet.admission(receipt);

  // Settled, actual is null (not 0 or estimated), unknown usage flag recorded
  assert.equal(adm?.state, "settled");
  assert.equal(adm?.actual, null);
  const usage = JSON.parse(adm?.usage_json ?? "{}");
  assert.equal(usage.unknown, true);

  // User is NOT locked out by ACCOUNT_RECONCILIATION_REQUIRED on next request
  const nextResponse = await governedInference(
    new Request("http://router.test/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: exemptModel.id,
        messages: [{ role: "user", content: "hello next" }],
        stream: false,
      }),
    }),
    async () => {
      recordGovernedDispatch();
      recordGovernedUsage({ prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 });
      return Response.json({ choices: [{ message: { content: "ok 2" } }] });
    }
  );
  assert.equal(nextResponse.status, 200);
});

test("exempt admission does not cause subsequent normal requests to block via uncertain check", async () => {
  const { key } = await setupUser(5000);

  // Make an exempt call that has unknown usage
  await governedInference(
    new Request("http://router.test/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: exemptModel.id,
        messages: [{ role: "user", content: "exempt call" }],
        stream: false,
      }),
    }),
    async () => {
      recordGovernedDispatch();
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    }
  );

  // Now make a normal request to activeModel
  const normalResponse = await governedInference(
    new Request("http://router.test/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: activeModel.id,
        messages: [{ role: "user", content: "normal call" }],
        stream: false,
      }),
    }),
    async () => {
      recordGovernedDispatch();
      recordGovernedUsage({ prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 });
      return Response.json({ choices: [{ message: { content: "ok normal" } }] });
    }
  );

  // Must not be blocked by ACCOUNT_RECONCILIATION_REQUIRED
  assert.equal(normalResponse.status, 200);
});

test("Combo with solely quota-exempt targets admits 0-balance user and settles without debit", async () => {
  const { id, key } = await setupUser(0); // 0 balance

  // Public path call: model is combo name 'combo-exempt'
  const response = await governedInference(
    new Request("http://router.test/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "combo-exempt",
        messages: [{ role: "user", content: "hello combo" }],
        stream: false,
      }),
    }),
    async () => {
      recordGovernedDispatch();
      recordGovernedUsage({ prompt_tokens: 15, completion_tokens: 10, total_tokens: 25 });
      return Response.json({ choices: [{ message: { content: "combo ok" } }] });
    }
  );

  assert.equal(response.status, 200);
  const receipt = response.headers.get("x-bpbatam-receipt")!;
  const adm = wallet.admission(receipt);
  assert.equal(adm?.state, "settled");
  assert.equal(adm?.actual, 25);

  const limits = JSON.parse(adm?.limits_json ?? "{}");
  assert.equal(limits.quota_exempt, true);

  // Zero balance remains 0 without debit
  assert.equal(wallet.account(id)?.balance, 0);
  assert.equal(wallet.account(id)?.reserved, 0);
});

test("Mixed-target Combo rejects 0-balance user at admission so metered fallback cannot be bypassed", async () => {
  const { key } = await setupUser(0); // 0 balance

  // Calling mixed combo with 0 balance must be rejected at admission (cannot bypass metered fallback)
  const response = await governedInference(
    new Request("http://router.test/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "combo-mixed",
        messages: [{ role: "user", content: "hello mixed" }],
        stream: false,
      }),
    }),
    async () => Response.json({ choices: [] })
  );

  assert.equal(response.status, 429);
  const data = await response.json();
  assert.equal(data.error?.message, "INSUFFICIENT_TOKENS");
});

test("Mixed-target Combo admits user with balance, debiting according to metered execution", async () => {
  const { id, key } = await setupUser(10000); // 10000 balance (accommodates default output bound)

  const response = await governedInference(
    new Request("http://router.test/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "combo-mixed",
        max_tokens: 100,
        messages: [{ role: "user", content: "hello mixed" }],
        stream: false,
      }),
    }),
    async () => {
      recordGovernedDispatch();
      recordGovernedUsage({ prompt_tokens: 50, completion_tokens: 50, total_tokens: 100 });
      return Response.json({ choices: [{ message: { content: "mixed ok" } }] });
    }
  );

  assert.equal(response.status, 200);
  const receipt = response.headers.get("x-bpbatam-receipt")!;
  const adm = wallet.admission(receipt);
  assert.equal(adm?.state, "settled");
  assert.equal(adm?.actual, 100);

  // Mixed combo was not quota-exempt; balance was debited for 100 tokens
  assert.equal(wallet.account(id)?.balance, 9900);
  assert.equal(wallet.account(id)?.reserved, 0);
});

test("quota exemption snapshot is retained across restart and late receipts", async () => {
  const { id, key } = await setupUser(1000);

  // Reserve an exempt inference
  const adm = wallet.reserve(
    "restart-receipt-1",
    key.id,
    500,
    "/v1/chat/completions",
    exemptModel.id,
    [],
    undefined,
    undefined,
    { quotaExempt: true }
  );
  assert.equal(adm.state, "reserved");
  // Wallet balance not reserved
  assert.equal(wallet.account(id)?.reserved, 0);

  // Simulate process restart
  core.resetDbInstance();

  // Late settlement after restart
  const settleResult = wallet.settle("restart-receipt-1", 120, {
    total: 120,
    unit: "provider-token",
    version: 1,
  });
  assert.equal(settleResult, "settled");

  // Verified: no balance debited
  assert.equal(wallet.account(id)?.balance, 1000);
  assert.equal(wallet.account(id)?.reserved, 0);

  const updated = wallet.admission("restart-receipt-1");
  assert.equal(updated?.state, "settled");
  assert.equal(updated?.actual, 120);
});

test("in-flight request retains exempt snapshot when model is re-configured to quota_enabled: true", async () => {
  const { id, key } = await setupUser(500);

  // Start with exempt reservation
  wallet.reserve(
    "in-flight-test-1",
    key.id,
    200,
    "/v1/chat/completions",
    exemptModel.id,
    [],
    undefined,
    undefined,
    { quotaExempt: true }
  );

  // Administrator updates model to quota_enabled: true
  customEndpoints.updateCustomEndpointModel(ep1.id, exemptModel.upstream_id, {
    quota_enabled: true,
  });
  assert.equal(customEndpoints.isCustomModelQuotaExempt(exemptModel.id), false);

  // In-flight settlement completes using persisted decision at admission time
  wallet.settle("in-flight-test-1", 75, { total: 75, unit: "provider-token" });

  // No debit occurred on the in-flight request
  assert.equal(wallet.account(id)?.balance, 500);
  assert.equal(wallet.account(id)?.reserved, 0);

  // Restore model quota_enabled back to false for further tests
  customEndpoints.updateCustomEndpointModel(ep1.id, exemptModel.upstream_id, {
    quota_enabled: false,
  });
});
