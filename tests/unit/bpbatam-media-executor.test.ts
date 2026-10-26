import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bp-media-"));
process.env.DATA_DIR = directory;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.API_KEY_SECRET = "synthetic-media-unit-test-crc-secret";
process.env.BPBATAM_MEDIA_EXECUTOR_URL = "http://executor.test/api/internal/media";
process.env.BPBATAM_OIDC_ISSUER = "http://identity.test/realms/bpbatam";
process.env.BPBATAM_MEDIA_CLIENT_SECRET = "synthetic-client-secret";
process.env.BPBATAM_MEDIA_TOKEN_UNITS = JSON.stringify({
  "/v1/audio/speech": 10,
  "/v1/audio/transcriptions": 20,
});
let revision = "a".repeat(64);
let status = 200;
let state = "completed";
let dispatched = 0;
const originalFetch = globalThis.fetch;
const executorFetch: typeof fetch = async (input, options) => {
  const url = String(input);
  if (url.endsWith("/protocol/openid-connect/token"))
    return Response.json({ access_token: "synthetic-machine-jwt", expires_in: 300 });
  if (url.endsWith("/settings")) return Response.json({ revision });
  if (url.endsWith("/v1/audio/transcriptions")) {
    const headers = new Headers(options?.headers);
    assert.equal(headers.get("authorization"), "Bearer synthetic-machine-jwt");
    assert.equal(wallet.admission(headers.get("x-bpbatam-receipt")!)?.state, "reserved");
    assert.ok(options?.body instanceof FormData);
    assert.ok((options.body as FormData).get("file") instanceof Blob);
    dispatched++;
    return Response.json(
      { text: "selamat pagi" },
      { headers: { "X-CP-Media-State": "completed", "X-CP-Media-Audio-Seconds": "0.1" } }
    );
  }
  assert.equal(url, "http://executor.test/api/internal/media/v1/audio/speech");
  const headers = new Headers(options?.headers);
  assert.equal(headers.get("authorization"), "Bearer synthetic-machine-jwt");
  assert.equal(headers.get("x-bpbatam-media-revision"), revision);
  assert.equal(wallet.admission(headers.get("x-bpbatam-receipt")!)?.state, "reserved");
  dispatched++;
  return new Response(
    status === 200 ? "audio" : JSON.stringify({ error: { code: "SYNTHETIC_FAILURE" } }),
    {
      status,
      headers: {
        "Content-Type": status === 200 ? "audio/wav" : "application/json",
        "X-CP-Media-State": state,
      },
    }
  );
};
const core = await import("../../src/lib/db/core.ts");
const wallet = await import("../../src/lib/db/bpbatam.ts");
const keys = await import("../../src/lib/db/apiKeys.ts");
const models = await import("../../src/lib/db/models.ts");
const offers = await import("../../src/lib/bpbatam/offers.ts");
const providers = await import("../../src/lib/db/providers/nodes.ts");
const pricing = await import("../../src/lib/db/settings/pricing.ts");
const costs = await import("../../src/domain/costRules.ts");
const { governedInference } = await import("../../src/lib/bpbatam/inference.ts");
globalThis.fetch = executorFetch;
const provider = await providers.createProviderNode({
  id: "native-tts-node",
  prefix: "local-tts",
  type: "openai-compatible",
  name: "Synthetic TTS",
});
await models.addCustomModel(String(provider.id), "media-tts");
await providers.createProviderNode({
  id: "native-stt-node",
  prefix: "local-stt",
  type: "openai-compatible",
  name: "Synthetic STT",
});
await models.addCustomModel("native-stt-node", "media-stt");
await pricing.updatePricing({
  "native-tts-node": { "media-tts": { input_cost_per_character: 0.001 } },
});
wallet.createAccount("root", null, "platform");
let count = 0;
async function identity(connections: string[] = []) {
  const id = "user-" + ++count;
  const key = await keys.createApiKey(id, "unit-machine", [], { allowedConnections: connections });
  wallet.createAccount(id, "root", "user");
  wallet.allocate("grant-" + id, null, id, 100, "issuer");
  wallet.bindPrincipal(id, "issuer", id, key.id);
  wallet.setOffers(id, await offers.publishedOffers());
  return { id, key };
}
async function invoke(key: string, id: string) {
  return governedInference(
    new Request("http://router.test/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        "Idempotency-Key": id,
      },
      body: JSON.stringify({ model: "local-tts/media-tts", input: "Synthetic audio" }),
    }),
    () => {
      throw new Error("Legacy executor must not be called");
    }
  );
}
test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("managed media uses machine identity and settles its native receipt once", async () => {
  const { id, key } = await identity();
  const response = await invoke(key.key, "success");
  assert.equal(response.status, 200);
  assert.equal(wallet.account(id)?.balance, 90);
  assert.equal(wallet.account(id)?.reserved, 0);
  assert.equal(costs.getCostSummary(key.id).totalCostToday, "Synthetic audio".length * 0.001);
  assert.equal(response.headers.get("x-omniroute-provider"), "native-tts-node");
  assert.equal(response.headers.get("X-CP-Media-State"), null);
  const before = dispatched;
  assert.equal((await invoke(key.key, "success")).status, 409);
  assert.equal(dispatched, before);
});
test("trusted rejection releases only the reservation; ambiguous provider failure remains held", async () => {
  const { id, key } = await identity();
  status = 400;
  state = "rejected";
  assert.equal((await invoke(key.key, "rejected")).status, 400);
  assert.equal(wallet.account(id)?.balance, 100);
  assert.equal(wallet.account(id)?.reserved, 0);
  status = 502;
  state = "uncertain";
  assert.equal((await invoke(key.key, "failed")).status, 502);
  assert.equal(wallet.account(id)?.reserved, 10);
  assert.equal(wallet.admission(key.id + ":failed")?.state, "uncertain");
  assert.equal((await invoke(key.key, "blocked")).status, 403);
  assert.equal(wallet.journalBalance(), 0);
  status = 200;
  state = "completed";
});
test("connection restriction and changed provider revision reject before reservation", async () => {
  const restricted = await identity(["explicit-provider-connection"]);
  const before = dispatched;
  assert.equal((await invoke(restricted.key.key, "scope")).status, 403);
  assert.equal(wallet.account(restricted.id)?.reserved, 0);
  const person = await identity();
  revision = "b".repeat(64);
  assert.equal((await invoke(person.key.key, "changed")).status, 409);
  assert.equal(wallet.account(person.id)?.reserved, 0);
  assert.equal(dispatched, before);
  revision = "a".repeat(64);
});

test("native financial budget still blocks subsequent media requests", async () => {
  const { key } = await identity();
  costs.setBudget(key.id, { dailyLimitUsd: 0.001, resetInterval: "daily" });
  const before = dispatched;
  assert.equal((await invoke(key.key, "budget-first")).status, 200);
  assert.equal((await invoke(key.key, "budget-next")).status, 429);
  assert.equal(dispatched, before + 1);
});

test("missing native media price cannot turn a configured budget into unlimited use", async () => {
  await pricing.resetPricing("native-tts-node", "media-tts");
  const { key } = await identity();
  costs.setBudget(key.id, { dailyLimitUsd: 1, resetInterval: "daily" });
  const before = dispatched;
  assert.equal((await invoke(key.key, "unpriced-first")).status, 200);
  assert.equal((await invoke(key.key, "unpriced-next")).status, 429);
  assert.equal(dispatched, before + 1);
});

test("oversized streamed media is rejected before parsing, reserving or executing", async () => {
  const { id, key } = await identity();
  let chunks = 0;
  const chunk = new Uint8Array(128 * 1024).fill(97);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunks++ < 257) controller.enqueue(chunk);
      else controller.close();
    },
  });
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: { Authorization: "Bearer " + key.key, "Content-Type": "application/json" },
    body,
    duplex: "half",
  };
  const before = dispatched;
  const response = await governedInference(
    new Request("http://router.test/v1/audio/speech", init),
    () => {
      throw new Error("Oversized request must not dispatch");
    }
  );
  assert.equal(response.status, 413);
  assert.equal(wallet.account(id)?.balance, 100);
  assert.equal(wallet.account(id)?.reserved, 0);
  assert.equal(dispatched, before);
});

test("TTS rejects multipart instead of bypassing its native character accounting", async () => {
  const { id, key } = await identity();
  const form = new FormData();
  form.set("model", "local-tts/media-tts");
  form.set("input", "Must not bypass pricing");
  const before = dispatched;
  const response = await governedInference(
    new Request("http://router.test/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: "Bearer " + key.key },
      body: form,
    }),
    () => {
      throw new Error("Unsupported body must not dispatch");
    }
  );
  assert.equal(response.status, 415);
  assert.equal(wallet.account(id)?.reserved, 0);
  assert.equal(dispatched, before);
});

test("bounded multipart transcription keeps its file and measured native receipt", async () => {
  const { id, key } = await identity();
  const form = new FormData();
  form.set("model", "local-stt/media-stt");
  form.set("file", new Blob(["synthetic-audio"], { type: "audio/wav" }), "audio.wav");
  const response = await governedInference(
    new Request("http://router.test/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: "Bearer " + key.key },
      body: form,
    }),
    () => {
      throw new Error("Legacy executor must not be used");
    }
  );
  assert.equal(response.status, 200);
  assert.equal(wallet.account(id)?.balance, 80);
  assert.equal(wallet.receipts(id)[0].usage.audio_seconds, 0.1);
  assert.equal(response.headers.get("X-CP-Media-Audio-Seconds"), null);
});
