import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bp-meeting-speech-"));
process.env.DATA_DIR = directory;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.API_KEY_SECRET = "synthetic-speech-test-secret";
process.env.BPBATAM_MEDIA_TOKEN_UNITS = JSON.stringify({
  "/v1/audio/speech": 10,
  "/v1/audio/transcriptions": 20,
});
const pair = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(pair.publicKey)), kid: "speech-test", alg: "RS256" };
const revision = "b".repeat(64);
let dispatched = 0;
let mode = "ok";
const asrFiles: string[] = [];
const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url?.endsWith("/certs")) return res.end(JSON.stringify({ keys: [jwk] }));
  if (req.url?.endsWith("/token"))
    return res.end(JSON.stringify({ access_token: "test-machine", expires_in: 300 }));
  if (req.url === "/settings") return res.end(JSON.stringify({ revision }));
  if (req.url === "/meeting-policy?kind=tts")
    return res.end(JSON.stringify({ revision, offer_id: "local-tts/media-tts" }));
  if (req.url === "/meeting-policy?kind=stt")
    return res.end(JSON.stringify({ revision, offer_id: "local-stt/media-stt" }));
  if (req.url === "/v1/audio/transcriptions") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    asrFiles.push(raw.match(/filename="([^"]+)"/)?.[1] ?? "missing");
    res.setHeader("X-CP-Media-State", "completed");
    res.setHeader("X-CP-Media-Audio-Seconds", "0.1");
    return res.end(
      JSON.stringify({ text: "Apa keputusan?", segments: [], deployment_id: "asr-fixture" })
    );
  }
  if (req.url === "/v1/audio/speech") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    assert.deepEqual(JSON.parse(raw), {
      model: "local-tts/media-tts",
      input: "Saved answer",
      response_format: "wav",
    });
    dispatched++;
    res.statusCode = mode === "ok" ? 200 : 502;
    res.setHeader("X-CP-Media-State", mode === "ok" ? "completed" : "uncertain");
    res.setHeader("X-Meeting-Deployment", "speech-fixture");
    res.setHeader("X-Meeting-Adapter", "openai-speech-v1");
    res.setHeader("X-Meeting-Model-Version", "test-v1");
    res.setHeader("Content-Type", "audio/wav");
    return res.end("RIFFfixtureWAVE");
  }
  res.statusCode = 404;
  res.end("{}");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + (server.address() as import("node:net").AddressInfo).port;
process.env.BPBATAM_MEDIA_EXECUTOR_URL = origin;
process.env.BPBATAM_OIDC_ISSUER = origin;
process.env.BPBATAM_SERVICE_AUDIENCE = "meeting-tests";
process.env.BPBATAM_MEDIA_CLIENT_SECRET = "synthetic-client-secret";
const core = await import("../../src/lib/db/core.ts");
const wallet = await import("../../src/lib/db/bpbatam.ts");
const keys = await import("../../src/lib/db/apiKeys.ts");
const providers = await import("../../src/lib/db/providers/nodes.ts");
const models = await import("../../src/lib/db/models.ts");
const offers = await import("../../src/lib/bpbatam/offers.ts");
const { meetingInference } = await import("../../src/lib/bpbatam/meeting.ts");
await providers.createProviderNode({
  id: "speech-node",
  prefix: "local-tts",
  type: "openai-compatible",
  name: "Speech fixture",
});
await models.addCustomModel("speech-node", "media-tts");
await providers.createProviderNode({
  id: "voice-asr-node",
  prefix: "local-stt",
  type: "openai-compatible",
  name: "Question ASR fixture",
});
await models.addCustomModel("voice-asr-node", "media-stt");
wallet.createAccount("bpbatam", null, "platform");
let sequence = 0;
async function identity() {
  const subject = "speech-member-" + ++sequence;
  const key = await keys.createApiKey(subject, "meeting-test");
  wallet.createAccount(subject, "bpbatam", "user");
  wallet.allocate("fund-" + subject, null, subject, 100, origin);
  wallet.bindPrincipal(subject, origin, subject, key.id);
  const assigned = await offers.publishedOffers();
  wallet.setOffers(subject, assigned);
  await keys.updateApiKeyPermissions(key.id, {
    modelAccessMode: "restricted",
    allowedModels: assigned.map((offer) => offer.id),
  });
  return subject;
}
async function invoke(body: object, azp = "bpbatam-control-plane-service") {
  const token = await new SignJWT({ azp, realm_access: { roles: ["bp:meeting-infer"] } })
    .setProtectedHeader({ alg: "RS256", kid: "speech-test" })
    .setIssuer(origin)
    .setAudience("meeting-tests")
    .setSubject("executor")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(pair.privateKey);
  return meetingInference(
    new Request(origin + "/api/bpbatam/meeting-inference", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}
test.after(() => {
  server.closeAllConnections();
  server.close();
  core.resetDbInstance();
  fs.rmSync(directory, { recursive: true, force: true });
});
test("trusted saved-answer speech uses native admission once and returns playable bytes privately", async () => {
  const subject = await identity();
  const body = {
    subject,
    issuer: origin,
    operation: "tts",
    operation_id: randomUUID(),
    attempt_id: randomUUID(),
    answer_id: randomUUID(),
    policy_revision: revision,
    input: "Saved answer",
  };
  const response = await invoke(body);
  assert.equal(response.status, 200, await response.clone().text());
  const outcome = await response.json();
  assert.equal(outcome.state, "completed");
  assert.equal(outcome.receipt_state, "settled");
  assert.equal(Buffer.from(outcome.audio_base64, "base64").toString(), "RIFFfixtureWAVE");
  assert.equal(wallet.meetingAdmission(outcome.receipt_id)?.operation_kind, "tts");
  assert.equal(wallet.meetingAdmission(outcome.receipt_id)?.provenance?.answer_id, body.answer_id);
  assert.equal(wallet.account(subject)?.balance, 90);
  assert.equal((await (await invoke(body)).json()).state, "uncertain");
  assert.equal(dispatched, 1);
  const status = await (
    await invoke({
      subject,
      issuer: origin,
      operation: "tts-status",
      operation_id: body.operation_id,
      attempt_id: body.attempt_id,
    })
  ).json();
  assert.equal(status.receipt_id, outcome.receipt_id);
  assert.equal(status.deployment_id, "speech-fixture");
  assert.equal(status.audio_base64, undefined);
});
test("speech rejects caller destination fields and untrusted executor without dispatch", async () => {
  const subject = await identity();
  const body = {
    subject,
    issuer: origin,
    operation: "tts",
    operation_id: randomUUID(),
    attempt_id: randomUUID(),
    answer_id: randomUUID(),
    policy_revision: revision,
    input: "Saved answer",
  };
  const before = dispatched;
  assert.equal((await invoke({ ...body, base_url: "https://outside.invalid" })).status, 422);
  assert.equal((await invoke(body, "bpbatam-librechat-service")).status, 403);
  assert.equal((await invoke({ ...body, policy_revision: "a".repeat(64) })).status, 409);
  assert.equal(dispatched, before);
});
test("uncertain speech retains the original receipt without a hidden retry", async () => {
  const subject = await identity();
  mode = "fail";
  const body = {
    subject,
    issuer: origin,
    operation: "tts",
    operation_id: randomUUID(),
    attempt_id: randomUUID(),
    answer_id: randomUUID(),
    policy_revision: revision,
    input: "Saved answer",
  };
  const before = dispatched;
  const first = await (await invoke(body)).json();
  assert.equal(first.state, "uncertain");
  assert.equal(first.receipt_state, "uncertain");
  assert.equal(wallet.account(subject)?.reserved, 10);
  assert.equal((await (await invoke(body)).json()).receipt_id, first.receipt_id);
  assert.equal(dispatched, before + 1);
  mode = "ok";
});
test("trusted voice ASR keeps distinct native receipts and read-only status without changing ordinary STT", async () => {
  const subject = await identity();
  const wav = Buffer.alloc(44 + 3200);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(3200, 40);
  const body = {
    subject,
    issuer: origin,
    operation: "stt",
    input_kind: "question",
    operation_id: randomUUID(),
    attempt_id: randomUUID(),
    policy_revision: revision,
    audio_base64: wav.toString("base64"),
  };
  assert.equal((await invoke({ ...body, input_kind: "participant" })).status, 422);
  assert.equal((await invoke(body, "bpbatam-librechat-service")).status, 403);
  assert.equal(asrFiles.length, 0);
  const response = await invoke(body);
  assert.equal(response.status, 200, await response.clone().text());
  const value = await response.json();
  assert.equal(value.text, "Apa keputusan?");
  assert.equal(wallet.admission(value.receipt_id)?.state, "settled");
  assert.equal(wallet.meetingAdmission(value.receipt_id)?.attempt_id, body.attempt_id);
  assert.equal(wallet.meetingAdmission(value.receipt_id)?.provenance?.input_kind, "question");
  assert.equal(wallet.account(subject)?.balance, 80);
  assert.equal((await invoke(body)).status, 409);
  const status = await (
    await invoke({
      subject,
      issuer: origin,
      operation: "stt-status",
      operation_id: body.operation_id,
      attempt_id: body.attempt_id,
    })
  ).json();
  assert.equal(status.receipt_id, value.receipt_id);
  assert.equal(status.receipt_state, "settled");
  assert.equal(status.audio_base64, undefined);
  assert.equal(status.text, undefined);
  assert.equal(asrFiles.length, 1);
  const ordinary = await invoke({
    ...body,
    input_kind: undefined,
    operation_id: randomUUID(),
    attempt_id: randomUUID(),
  });
  assert.equal(ordinary.status, 200, await ordinary.clone().text());
  const ordinaryValue = await ordinary.json();
  assert.equal(
    wallet.meetingAdmission(ordinaryValue.receipt_id)?.provenance?.input_kind,
    undefined
  );
  assert.deepEqual(asrFiles, ["question.wav", "frame.wav"]);
  assert.equal(wallet.account(subject)?.balance, 60);
});
