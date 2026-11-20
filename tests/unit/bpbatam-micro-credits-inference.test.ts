import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-micro-infer-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.API_KEY_SECRET = "synthetic-micro-credits-inference-secret";

const core = await import("../../src/lib/db/core.ts");
const wallet = await import("../../src/lib/db/bpbatam.ts");
const keys = await import("../../src/lib/db/apiKeys.ts");
const providers = await import("../../src/lib/db/providers/nodes.ts");
const models = await import("../../src/lib/db/models.ts");
const offers = await import("../../src/lib/bpbatam/offers.ts");
const digiDb = await import("../../src/lib/db/bpbatamDigiSync.ts");
const quotas = await import("../../src/lib/db/bpbatamQuotas.ts");
const creditUnits = await import("../../src/lib/bpbatam/creditUnits.ts");
const { GOVERNED_PATHS, governedInference } = await import("../../src/lib/bpbatam/inference.ts");
const { recordGovernedDispatch, recordGovernedUpstreamHeaders, recordGovernedUsage } =
  await import("../../src/lib/bpbatam/context.ts");

await providers.createProviderNode({
  id: "digi-oai-node",
  prefix: "digi-oai",
  type: "openai-compatible",
  name: "Digi Route OAI",
});
await models.addCustomModel("digi-oai-node", "gpt-6.1-terra");
await models.addCustomModel("digi-oai-node", "rerank-v4.0-pro");
await models.addCustomModel("digi-oai-node", "legacy-local-model");

digiDb.upsertDigiModelCreditRates([
  {
    model_id: "gpt-6.1-terra",
    input_micro_credits_per_1m: 3_651_000,
    cached_micro_credits_per_1m: 182_550,
    output_micro_credits_per_1m: 18_255_000,
  },
]);

wallet.createAccount("bpbatam", null, "platform");

let seq = 0;
async function createUserWithCredits(credits: number) {
  const id = `credit-user-${++seq}`;
  const key = await keys.createApiKey(id, "unit-test");
  const micro = creditUnits.creditsToMicroCredits(credits);
  wallet.createAccount(id, "bpbatam", "user");
  wallet.allocate(`grant-${id}`, null, id, micro, "issuer");
  wallet.bindPrincipal(id, "issuer", id, key.id);
  wallet.setOffers(id, await offers.publishedOffers());
  return { id, key, micro };
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("credit unit conversion helpers convert between Credits, micro_credits, and token equivalents", () => {
  assert.equal(creditUnits.MICRO_CREDITS_PER_CREDIT, 1_000_000);
  assert.equal(creditUnits.creditsToMicroCredits(10), 10_000_000);
  assert.equal(creditUnits.creditsToMicroCredits("1.500000"), 1_500_000);
  assert.equal(creditUnits.formatCreditsFromMicro(200_000_000), "200.000000");
  assert.equal(creditUnits.microCreditsToCredits(2_500_000), 2.5);
  assert.equal(creditUnits.microCreditsToEstimatedTokens(1_000_000, 152_200), 152_200);
  assert.equal(creditUnits.estimatedTokensToMicroCredits(152_200, 152_200), 1_000_000);
});

test("governedInference reserves micro_credits using synced model rate, forwards X-BPRoute-Receipt-Id, and settles via X-DigiRoute-Credit-Charged-Micro", async () => {
  const { id, key, micro } = await createUserWithCredits(50); // 50_000_000 micro_credits
  let seenReceiptHeader = "";

  const res = await governedInference(
    new Request("http://router.test/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "digi-oai/gpt-6.1-terra",
        max_tokens: 1000,
        messages: [{ role: "user", content: "Halo" }],
        stream: false,
      }),
    }),
    async (forwarded) => {
      seenReceiptHeader =
        forwarded.headers.get("x-bpbatam-receipt") ??
        forwarded.headers.get("x-bproute-receipt-id") ??
        "";
      assert.ok(
        forwarded.headers.get("x-bproute-receipt-id"),
        "X-BPRoute-Receipt-Id must be forwarded upstream"
      );
      // During dispatch, admission is reserved in micro_credits (not raw tokens!)
      const activeAdm = wallet.admission(seenReceiptHeader);
      assert.ok(activeAdm);
      assert.equal(activeAdm.unit, "micro_credits");
      // Output bound 1000 tokens * 18_255_000 / 1e6 = 18_255 + small input bound
      assert.ok(activeAdm.reserved > 18_255 && activeAdm.reserved < 30_000);

      recordGovernedDispatch();
      const upstreamHeaders = new Headers({
        "Content-Type": "application/json",
        "X-DigiRoute-Receipt-Id": "dgr-rcpt-9001",
        "X-DigiRoute-Credit-Charged-Micro": "9492",
      });
      recordGovernedUpstreamHeaders(upstreamHeaders);
      recordGovernedUsage({
        prompt_tokens: 100,
        completion_tokens: 500,
        total_tokens: 600,
      });

      return Response.json(
        { choices: [{ message: { content: "Hai" } }] },
        { headers: upstreamHeaders }
      );
    }
  );

  assert.equal(res.status, 200);
  const receiptId = res.headers.get("x-bpbatam-receipt")!;
  assert.equal(receiptId, seenReceiptHeader);

  const settled = wallet.admission(receiptId)!;
  assert.equal(settled.state, "settled");
  assert.equal(settled.actual, 9492);
  assert.equal(settled.unit, "micro_credits");
  assert.equal(settled.digi_receipt_id, "dgr-rcpt-9001");

  const acct = wallet.accountCredits(id)!;
  assert.equal(acct.balance_micro, micro - 9492);
  assert.equal(acct.reserved_micro, 0);

  const receipts = wallet.receipts(id);
  assert.equal(receipts[0].actual_micro, 9492);
  assert.equal(receipts[0].raw_tokens.total, 600);
});

test("governedInference computes micro_credits settlement from synced model rates + cached tokens when Digi Route header is absent", async () => {
  const { id, key, micro } = await createUserWithCredits(50);
  quotas.changeUserLimitsInCredits("raise-for-test-" + id, id, quotas.userLimits(id).revision, {
    limits: [
      { window: "5h", credits: 10 },
      { window: "7d", credits: 20 },
      { window: "30d", credits: 50 },
    ],
  });

  // 1,000,000 input (200,000 uncached + 800,000 cached) + 100,000 output on gpt-6.1-terra:
  // uncached: 0.2 * 3_651_000 = 730_200
  // cached:   0.8 * 182_550   = 146_040
  // output:   0.1 * 18_255_000 = 1_825_500
  // total = 2_701_740 micro_credits
  const res = await governedInference(
    new Request("http://router.test/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "digi-oai/gpt-6.1-terra",
        max_tokens: 100_000,
        messages: [{ role: "user", content: "Analyze" }],
        stream: true,
      }),
    }),
    async () => {
      recordGovernedDispatch();
      recordGovernedUsage({
        prompt_tokens: 1_000_000,
        prompt_tokens_details: { cached_tokens: 800_000 },
        completion_tokens: 100_000,
        total_tokens: 1_100_000,
      });
      return new Response("data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
    }
  );

  assert.equal(res.status, 200);
  await res.text();
  const receiptId = res.headers.get("x-bpbatam-receipt")!;
  const adm = wallet.admission(receiptId)!;
  assert.equal(adm.state, "settled");
  assert.equal(adm.actual, 2_701_740);
  assert.equal(wallet.account(id)?.balance, micro - 2_701_740);
  assert.equal(wallet.account(id)?.reserved, 0);
});

test("calculateReservationMicroCredits and governedInference handle /v1/rerank with tokens_1m rate without MEDIA_UNIT_POLICY_REQUIRED", async () => {
  digiDb.upsertDigiModelCreditRates([
    {
      model_id: "rerank-v4.0-pro",
      input_micro_credits_per_1m: 1_000_000,
      cached_micro_credits_per_1m: 0,
      output_micro_credits_per_1m: 0,
      unit_micro_credits: 0,
      request_fee_micro_credits: 10,
      billing_unit: "tokens_1m",
    },
  ]);

  const { calculateReservationMicroCredits } =
    await import("../../src/lib/bpbatam/digiCreditSync.ts");
  const resCalc = calculateReservationMicroCredits({
    path: "/v1/rerank",
    model: "digi-oai/rerank-v4.0-pro",
    body: {
      model: "digi-oai/rerank-v4.0-pro",
      query: "kebijakan kredit",
      documents: ["dokumen satu", "dokumen dua"],
    },
  });
  assert.equal(resCalc.unit, "micro_credits");
  assert.ok(resCalc.amount >= 11);

  const { id, key, micro } = await createUserWithCredits(20);
  const res = await governedInference(
    new Request("http://router.test/v1/rerank", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "digi-oai/rerank-v4.0-pro",
        query: "kebijakan kredit",
        documents: ["dokumen satu", "dokumen dua"],
      }),
    }),
    async () =>
      Response.json({
        results: [{ index: 0, relevance_score: 0.99 }],
        usage: { total_tokens: 500_000 },
      })
  );

  assert.equal(res.status, 200);
  const receiptId = res.headers.get("x-bpbatam-receipt")!;
  const adm = wallet.admission(receiptId)!;
  assert.equal(adm.state, "settled");
  // 500,000 / 1,000,000 * 1,000,000 + 10 = 500,010 micro_credits
  assert.equal(adm.actual, 500_010);
  assert.equal(wallet.account(id)?.balance, micro - 500_010);
  assert.equal(wallet.account(id)?.reserved, 0);
});

test("GOVERNED_PATHS includes /v1/messages and /v1/responses and route handlers wrap dispatch in governedInference", async () => {
  assert.equal(GOVERNED_PATHS.has("/v1/messages"), true);
  assert.equal(GOVERNED_PATHS.has("/v1/responses"), true);

  const messagesRouteSource = fs.readFileSync(
    path.join(process.cwd(), "src/app/api/v1/messages/route.ts"),
    "utf8"
  );
  const responsesRouteSource = fs.readFileSync(
    path.join(process.cwd(), "src/app/api/v1/responses/route.ts"),
    "utf8"
  );
  assert.match(messagesRouteSource, /governedInference/);
  assert.match(responsesRouteSource, /governedInference/);

  const { id, key, micro } = await createUserWithCredits(20);
  const resMsg = await governedInference(
    new Request("http://router.test/v1/messages", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "digi-oai/gpt-6.1-terra",
        max_tokens: 500,
        messages: [{ role: "user", content: "Halo" }],
        stream: false,
      }),
    }),
    async () => {
      recordGovernedDispatch();
      const headers = new Headers({
        "Content-Type": "application/json",
        "X-DigiRoute-Receipt-Id": "dgr-msg-1",
        "X-DigiRoute-Credit-Charged-Micro": "1200",
      });
      recordGovernedUpstreamHeaders(headers);
      recordGovernedUsage({ input_tokens: 50, output_tokens: 50 });
      return Response.json({ id: "msg_1", type: "message" }, { headers });
    }
  );
  assert.equal(resMsg.status, 200);
  const rcptId = resMsg.headers.get("x-bpbatam-receipt")!;
  assert.equal(wallet.admission(rcptId)?.state, "settled");
  assert.equal(wallet.admission(rcptId)?.actual, 1200);
  assert.equal(wallet.account(id)?.balance, micro - 1200);
});
