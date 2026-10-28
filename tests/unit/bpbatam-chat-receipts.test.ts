import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Request as AdapterRequest } from "undici";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bp-chat-receipts-"));
process.env.DATA_DIR = directory;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.API_KEY_SECRET = "synthetic-chat-receipts-unit-test-secret";
const core = await import("../../src/lib/db/core.ts");
const wallet = await import("../../src/lib/db/bpbatam.ts");
const keys = await import("../../src/lib/db/apiKeys.ts");
const providers = await import("../../src/lib/db/providers/nodes.ts");
const models = await import("../../src/lib/db/models.ts");
const offers = await import("../../src/lib/bpbatam/offers.ts");
const { governedInference } = await import("../../src/lib/bpbatam/inference.ts");
const { recordGovernedDispatch, recordGovernedUsage } =
  await import("../../src/lib/bpbatam/context.ts");

await providers.createProviderNode({
  id: "receipt-test-node",
  prefix: "receipt-test",
  type: "openai-compatible",
  name: "Synthetic receipt tests",
});
await models.addCustomModel("receipt-test-node", "chat");
wallet.createAccount("root", null, "platform");
let sequence = 0;
async function invoke(dispatch: () => Response, stream = true, expectedStatus = 200) {
  const id = "user-" + ++sequence;
  const key = await keys.createApiKey(id, "unit-test");
  wallet.createAccount(id, "root", "user");
  wallet.allocate("grant-" + id, null, id, 20000, "issuer");
  wallet.bindPrincipal(id, "issuer", id, key.id);
  wallet.setOffers(id, await offers.publishedOffers());
  const response = await governedInference(
    new Request("http://router.test/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "receipt-test/chat",
        max_tokens: 1000,
        messages: [{ role: "user", content: "Hello" }],
        stream,
      }),
    }),
    dispatch
  );
  assert.equal(response.status, expectedStatus);
  const receipt = response.headers.get("x-bpbatam-receipt")!;
  assert.ok(receipt);
  return { id, response, receipt };
}
function assertHeld(id: string, receipt: string) {
  assert.equal(wallet.admission(receipt)?.state, "uncertain");
  assert.equal(wallet.admission(receipt)?.actual, null);
  assert.ok(wallet.account(id)!.reserved > 0);
  assert.equal(wallet.account(id)?.balance, 20000);
}
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("cancelling a dispatched chat retains its reservation and permits an authoritative late receipt", async () => {
  const { id, response, receipt } = await invoke(() => {
    recordGovernedDispatch();
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"delta":"generated"}\n\n'));
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } }
    );
  });
  const reader = response.body!.getReader();
  assert.equal((await reader.read()).done, false);
  await reader.cancel();
  assertHeld(id, receipt);
  wallet.settle(receipt, 120, { total: 120, unit: "provider-token", version: 1 });
  assert.equal(wallet.account(id)?.balance, 19880);
  assert.equal(wallet.account(id)?.reserved, 0);
});

test("a chat stream ending without provider usage retains its reservation", async () => {
  const { id, response, receipt } = await invoke(() => {
    recordGovernedDispatch();
    return new Response("data: [DONE]\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  await response.text();
  assertHeld(id, receipt);
});

test("a non-streaming chat without provider usage retains its reservation", async () => {
  const { id, receipt } = await invoke(() => {
    recordGovernedDispatch();
    return Response.json({ choices: [{ message: { content: "Generated answer" } }] });
  }, false);
  assertHeld(id, receipt);
});

test("a trusted chat receipt remains settled when its stream closes", async () => {
  const { id, response, receipt } = await invoke(() => {
    recordGovernedDispatch();
    recordGovernedUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
    return new Response("data: [DONE]\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  await response.text();
  assert.equal(wallet.admission(receipt)?.state, "settled");
  assert.equal(wallet.account(id)?.balance, 19880);
  assert.equal(wallet.account(id)?.reserved, 0);
});

test("post-dispatch chat failures retain their reservation", async () => {
  const { id, receipt } = await invoke(
    () => {
      recordGovernedDispatch();
      return Response.json({ error: "Synthetic upstream failure" }, { status: 502 });
    },
    true,
    502
  );
  assertHeld(id, receipt);
});

test("an interrupted dispatched chat stream retains its reservation", async () => {
  const { id, response, receipt } = await invoke(() => {
    recordGovernedDispatch();
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("Synthetic interrupted stream"));
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } }
    );
  });
  await assert.rejects(response.text(), /Synthetic interrupted stream/);
  assertHeld(id, receipt);
});

test("a rejection before provider dispatch releases its unused reservation", async () => {
  const { id, receipt } = await invoke(
    () => Response.json({ error: "Synthetic local rejection" }, { status: 400 }),
    true,
    400
  );
  assert.equal(wallet.admission(receipt)?.state, "settled");
  assert.equal(wallet.admission(receipt)?.actual, 0);
  assert.equal(wallet.account(id)?.reserved, 0);
});

test("streaming requests from another Request implementation keep their usage receipt", async () => {
  const id = "user-" + ++sequence;
  const key = await keys.createApiKey(id, "unit-test");
  wallet.createAccount(id, "root", "user");
  wallet.allocate("grant-" + id, null, id, 20000, "issuer");
  wallet.bindPrincipal(id, "issuer", id, key.id);
  wallet.setOffers(id, await offers.publishedOffers());
  let dispatched = false;
  const request = new AdapterRequest("http://router.test/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + key.key, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "receipt-test/chat",
      max_tokens: 1000,
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
    }),
  });
  const response = await governedInference(request as unknown as Request, async (forwarded) => {
    dispatched = true;
    const body = await forwarded.json();
    assert.equal(body.stream_options.include_usage, true);
    assert.equal(body.messages[0].content, "Hello");
    recordGovernedDispatch();
    recordGovernedUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
    return new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  });
  assert.equal(response.status, 200);
  assert.equal(dispatched, true);
  await response.text();
  const receipt = response.headers.get("x-bpbatam-receipt")!;
  assert.equal(wallet.admission(receipt)?.state, "settled");
  assert.equal(wallet.account(id)?.reserved, 0);
});

test("an exception before provider dispatch releases an unused chat reservation", async () => {
  const { id, receipt } = await invoke(
    () => {
      throw new Error("Synthetic pre-dispatch exception");
    },
    true,
    503
  );
  assert.equal(wallet.admission(receipt)?.state, "settled");
  assert.equal(wallet.admission(receipt)?.actual, 0);
  assert.equal(wallet.account(id)?.reserved, 0);
});

test("an exception after provider dispatch retains its uncertain reservation", async () => {
  const { id, receipt } = await invoke(
    () => {
      recordGovernedDispatch();
      throw new Error("Synthetic post-dispatch exception");
    },
    true,
    503
  );
  assertHeld(id, receipt);
});
