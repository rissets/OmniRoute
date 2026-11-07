import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bp-meeting-completion-"));
process.env.DATA_DIR = directory;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.API_KEY_SECRET = "synthetic-meeting-completion-secret";
const pair = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(pair.publicKey)), kid: "meeting-test", alg: "RS256" };
let providerCalls = 0;
let redirects = 0;
let forgetCalls = 0;
let mode = "ready";
let received: Record<string, unknown>;
let authorization: string | undefined;
const revision = "b".repeat(64);
const modelVersion = "sherpa-onnx-1.12.32-pyannote3-wespeaker-resnet34-lm-v1";
const model = {
  id: "sherpa-onnx-offline-diarization",
  revision: modelVersion,
  segmentation: "pyannote-segmentation-3-0",
  embedding: "wespeaker-en-voxceleb-resnet34-LM",
  runtime: "sherpa-onnx",
  runtime_version: "1.12.32",
  provider: "cpu",
  sha256: {
    segmentation: "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079",
    embedding: "e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012",
  },
};
let deployment: Record<string, unknown>;
const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url?.endsWith("/certs")) return res.end(JSON.stringify({ keys: [jwk] }));
  if (req.url?.endsWith("/token"))
    return res.end(JSON.stringify({ access_token: "machine-test", expires_in: 300 }));
  if (req.url === "/settings") return res.end(JSON.stringify({ revision }));
  if (req.url?.startsWith("/meeting-policy"))
    return res.end(
      JSON.stringify({
        kind: "diarization",
        revision,
        offer_id: "local-stt/speakers",
        deployments: [deployment],
      })
    );
  if (req.method === "DELETE" && req.url?.startsWith("/v1/sessions/")) {
    forgetCalls++;
    assert.equal(req.headers.authorization, "Bearer synthetic-provider-key");
    if (mode === "forget_redirect") {
      res.statusCode = 307;
      res.setHeader("Location", "/leak");
      return res.end("{}");
    }
    return res.end(
      JSON.stringify({
        forgotten: true,
        session_id: mode === "forget_wrong" ? randomUUID() : req.url.split("/").at(-1),
      })
    );
  }
  if (req.url === "/leak") {
    redirects++;
    return res.end("{}");
  }
  if (req.url === "/v1/diarize") {
    providerCalls++;
    authorization = req.headers.authorization;
    let bytes = "";
    for await (const chunk of req) bytes += chunk;
    received = JSON.parse(bytes);
    if (mode === "redirect") {
      res.statusCode = 307;
      res.setHeader("Location", "/leak");
      return res.end("{}");
    }
    if (mode === "disconnect") return req.socket.destroy();
    if (mode === "failure") {
      res.statusCode = 503;
      return res.end("{}");
    }
    const end = Number(received.start_ms) + 1000;
    const segments =
      mode === "no_speech" || mode === "insufficient_audio"
        ? []
        : [
            {
              start_ms: mode === "out_of_range" ? end + 1 : Math.max(0, end - 1000),
              end_ms: end,
              speaker: "speaker_1",
              overlap: false,
            },
          ];
    return res.end(
      JSON.stringify({
        session_id: mode === "wrong_identity" ? randomUUID() : received.session_id,
        chunk_id: received.chunk_id,
        session_epoch: "4ed02df0-c915-43da-9492-0976555fed26",
        status: ["no_speech", "insufficient_audio"].includes(mode) ? mode : "ready",
        analyzed_start_ms: Math.max(0, end - 20000),
        analyzed_end_ms: end,
        segments,
        warnings: [],
        adapter_version: "speaker-embedding-v1",
        model_version: modelVersion,
        model: mode === "wrong_model" ? { ...model, runtime_version: "unverified" } : model,
      })
    );
  }
  res.statusCode = 404;
  res.end("{}");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + (server.address() as import("node:net").AddressInfo).port;
process.env.BPBATAM_MEDIA_EXECUTOR_URL = origin;
process.env.BPBATAM_MEDIA_TOKEN_UNITS = JSON.stringify({ "/v1/audio/diarizations": 120 });
process.env.BPBATAM_OIDC_ISSUER = origin;
process.env.BPBATAM_SERVICE_AUDIENCE = "meeting-tests";
process.env.BPBATAM_MEDIA_CLIENT_SECRET = "synthetic-client-secret";
const core = await import("../../src/lib/db/core.ts");
const wallet = await import("../../src/lib/db/bpbatam.ts");
const keys = await import("../../src/lib/db/apiKeys.ts");
const providers = await import("../../src/lib/db/providers.ts");
const models = await import("../../src/lib/db/models.ts");
const offers = await import("../../src/lib/bpbatam/offers.ts");
const { meetingInference } = await import("../../src/lib/bpbatam/meeting.ts");
function wav() {
  const data = Buffer.alloc(32000, 7),
    header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
await providers.createProviderNode({
  id: "local-speaker-fixture",
  prefix: "local-stt",
  apiType: "stt",
  type: "openai-compatible",
  name: "Meeting fixture",
  baseUrl: origin + "/v1",
});
await models.addCustomModel("local-speaker-fixture", "speakers");
const connection = await providers.createProviderConnection({
  provider: "local-speaker-fixture",
  authType: "apikey",
  apiKey: "synthetic-provider-key",
  isActive: true,
  proxyEnabled: false,
  perKeyProxyEnabled: false,
  providerSpecificData: {
    baseUrl: origin + "/v1",
    prefix: "local-stt",
    apiType: "stt",
    nodeName: "Meeting fixture",
    autoFetchModels: false,
  },
});
deployment = {
  id: "internal-chat",
  label: "Internal test",
  kind: "diarization",
  base_url: origin + "/v1",
  provider: "local-speaker-fixture",
  connection_id: connection.id,
  model: "speakers",
  ip_addresses: ["127.0.0.1"],
  attestation_id: "test-only",
  adapter_version: "speaker-embedding-v1",
  model_version: modelVersion,
};
wallet.createAccount("bpbatam", null, "platform");
let sequence = 0;
const keyIds = new Map<string, string>();
async function identity(funds = 100000) {
  const subject = "member-" + ++sequence;
  const key = await keys.createApiKey(subject, "meeting-test");
  wallet.createAccount(subject, "bpbatam", "user");
  wallet.allocate("fund-" + subject, null, subject, funds, origin);
  wallet.bindPrincipal(subject, origin, subject, key.id);
  keyIds.set(subject, key.id);
  const assigned = await offers.publishedOffers();
  wallet.setOffers(subject, assigned);
  await keys.updateApiKeyPermissions(key.id, {
    modelAccessMode: "restricted",
    allowedModels: assigned.filter((offer) => offer.kind === "model").map((offer) => offer.id),
    allowedCombos: assigned.filter((offer) => offer.kind === "combo").map((offer) => offer.id),
  });
  return subject;
}
async function invoke(
  subject: string,
  overrides: Record<string, unknown> = {},
  azp = "bpbatam-control-plane-service"
) {
  const jwt = await new SignJWT({ azp, realm_access: { roles: ["bp:meeting-infer"] } })
    .setProtectedHeader({ alg: "RS256", kid: "meeting-test" })
    .setSubject("cp-machine")
    .setIssuer(origin)
    .setAudience("meeting-tests")
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(pair.privateKey);
  return meetingInference(
    new Request(origin + "/meeting-inference", {
      method: "POST",
      headers: { Authorization: "Bearer " + jwt, "Content-Type": "application/json" },
      body: JSON.stringify({
        subject,
        issuer: origin,
        operation: "diarization",
        operation_id: randomUUID(),
        attempt_id: randomUUID(),
        policy_revision: revision,
        session_id: randomUUID(),
        chunk_id: randomUUID(),
        start_ms: 0,
        audio_base64: wav().toString("base64"),
        ...overrides,
      }),
    })
  );
}
test.after(async () => {
  core.resetDbInstance();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(directory, { recursive: true, force: true });
});

test("machine-authenticated diarization settles one pinned media call and exact audio seconds without content in its ledger", async () => {
  const subject = await identity();
  const before = providerCalls;
  const response = await invoke(subject, { start_ms: 25000 });
  assert.equal(response.status, 200, await response.clone().text());
  const value = await response.json();
  assert.equal(value.state, "completed");
  assert.equal(value.status, "ready");
  assert.equal(value.receipt_state, "settled");
  assert.equal(value.actual_tokens, 120);
  assert.equal(providerCalls, before + 1);
  assert.equal(authorization, "Bearer synthetic-provider-key");
  assert.equal(received.model, undefined);
  assert.equal(received.tools, undefined);
  assert.equal(value.destination_url, origin + "/v1/diarize");
  assert.equal(value.transport, "direct-pinned");
  const receipt = wallet.admission(value.receipt_id)!;
  assert.equal(receipt.actual, 120);
  assert.equal(wallet.account(subject)?.balance, 99880);
  assert.equal(JSON.parse(receipt.usage_json).audio_seconds, 1);
  const attempt = wallet.meetingAttempt(
    (
      core
        .getDbInstance()
        .prepare("SELECT attempt_id FROM bp_meeting_attempts WHERE receipt_id=?")
        .get(value.receipt_id) as { attempt_id: string }
    ).attempt_id
  )!;
  assert.equal(attempt.operation_kind, "diarization");
  assert.doesNotMatch(
    attempt.provenance_json,
    /audio_base64|speaker_1|synthetic-provider-key|segments/
  );
  assert.doesNotMatch(receipt.usage_json, /speaker_1|audio_base64|segments/);
  const { meetingUsage } = await import("../../src/lib/db/bpbatamMeetingUsage.ts");
  assert.equal(
    meetingUsage(
      {
        subject,
        issuer: origin,
        operation_id: attempt.operation_id,
        attempt_id: attempt.attempt_id,
      },
      "bpbatam"
    ).operation_kind,
    "diarization"
  );
});

test("insufficient audio and no speech remain honest completed charged statuses", async () => {
  for (const state of ["insufficient_audio", "no_speech"]) {
    mode = state;
    const value = await (await invoke(await identity())).json();
    assert.equal(value.state, "completed");
    assert.equal(value.status, state);
    assert.deepEqual(value.segments, []);
    assert.equal(value.receipt_state, "settled");
    assert.equal(value.actual_tokens, 120);
  }
  mode = "ready";
});

test("wrong caller, principal issuer, policy, key and offer cannot send private audio", async () => {
  const subject = await identity(),
    before = providerCalls;
  assert.equal((await invoke(subject, {}, "browser-client")).status, 403);
  assert.equal((await invoke(subject, { issuer: "http://wrong.invalid" })).status, 403);
  assert.equal((await invoke(subject, { policy_revision: "c".repeat(64) })).status, 409);
  await keys.updateApiKeyPermissions(keyIds.get(subject)!, {
    modelAccessMode: "restricted",
    allowedModels: [],
  });
  const denied = await (await invoke(subject)).json();
  assert.notEqual(denied.state, "completed");
  await keys.updateApiKeyPermissions(keyIds.get(subject)!, { isActive: false });
  assert.equal((await invoke(subject)).status, 403);
  assert.equal(providerCalls, before);
});

test("malformed base64, RIFF, stereo, sample rate and inconsistent sizes are rejected before dispatch", async () => {
  const subject = await identity(),
    before = providerCalls;
  const inputs = [
    "!bad",
    wav().toString("base64") + "=",
    Buffer.from("invalid wave".repeat(10)).toString("base64"),
  ];
  for (const [offset, width, value] of [
    [22, 2, 2],
    [24, 4, 8000],
    [40, 4, 9999999],
    [4, 4, 1],
  ]) {
    const audio = wav();
    width === 2 ? audio.writeUInt16LE(value, offset) : audio.writeUInt32LE(value, offset);
    inputs.push(audio.toString("base64"));
  }
  for (const audio_base64 of inputs)
    assert.ok([400, 422].includes((await invoke(subject, { audio_base64 })).status));
  assert.equal(providerCalls, before);
});

test("connection pin, proxy and DNS escape fail closed without physical dispatch", async () => {
  const subject = await identity(),
    before = providerCalls;
  await keys.updateApiKeyPermissions(keyIds.get(subject)!, { allowedConnections: ["unrelated"] });
  assert.equal((await invoke(subject)).status, 503);
  await keys.updateApiKeyPermissions(keyIds.get(subject)!, { allowedConnections: [] });
  await providers.updateProviderConnection(connection.id, { proxyEnabled: true });
  assert.equal((await invoke(subject)).status, 403);
  await providers.updateProviderConnection(connection.id, { proxyEnabled: false });
  const original = deployment.ip_addresses;
  const dnsBase = origin.replace("127.0.0.1", "localhost") + "/v1";
  await providers.updateProviderConnection(connection.id, {
    providerSpecificData: { baseUrl: dnsBase },
  });
  deployment.base_url = dnsBase;
  deployment.ip_addresses = ["127.0.0.2"];
  const result = await (await invoke(subject)).json();
  assert.equal(result.state, "rejected");
  assert.equal(result.receipt_state, "settled");
  assert.equal(result.actual_tokens, 0);
  deployment.ip_addresses = original;
  deployment.base_url = origin + "/v1";
  await providers.updateProviderConnection(connection.id, {
    providerSpecificData: { baseUrl: origin + "/v1" },
  });
  assert.equal(providerCalls, before);
});

test("malformed model output, identity and segment escape retain uncertainty after exactly one call", async () => {
  for (const state of ["wrong_model", "wrong_identity", "out_of_range"]) {
    const subject = await identity(),
      before = providerCalls;
    mode = state;
    const value = await (await invoke(subject)).json();
    assert.equal(value.state, "uncertain");
    assert.equal(value.receipt_state, "uncertain");
    assert.equal(value.actual_tokens, null);
    assert.equal(providerCalls, before + 1);
  }
  mode = "ready";
});

test("redirect, disconnect and failure never retry; replay and status are read only", async () => {
  for (const state of ["redirect", "disconnect", "failure"]) {
    const subject = await identity(),
      before = providerCalls;
    mode = state;
    const attempt = { operation_id: randomUUID(), attempt_id: randomUUID() };
    const value = await (await invoke(subject, attempt)).json();
    assert.equal(value.state, "uncertain");
    assert.equal(value.receipt_state, "uncertain");
    const replay = await (await invoke(subject, attempt)).json();
    assert.equal(replay.receipt_id, value.receipt_id);
    const status = await (await invokeStatus(subject, attempt)).json();
    assert.equal(status.receipt_id, value.receipt_id);
    assert.equal(providerCalls, before + 1);
    assert.equal(redirects, 0);
  }
  mode = "ready";
});

async function invokeStatus(
  subject: string,
  attempt: { operation_id: string; attempt_id: string }
) {
  const jwt = await new SignJWT({
    azp: "bpbatam-control-plane-service",
    realm_access: { roles: ["bp:meeting-infer"] },
  })
    .setProtectedHeader({ alg: "RS256", kid: "meeting-test" })
    .setSubject("cp-machine")
    .setIssuer(origin)
    .setAudience("meeting-tests")
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(pair.privateKey);
  return meetingInference(
    new Request(origin + "/meeting-inference", {
      method: "POST",
      headers: { Authorization: "Bearer " + jwt, "Content-Type": "application/json" },
      body: JSON.stringify({
        subject,
        issuer: origin,
        operation: "diarization-status",
        ...attempt,
      }),
    })
  );
}

test("missing media unit policy cannot dispatch audio", async () => {
  const subject = await identity(),
    before = providerCalls,
    previous = process.env.BPBATAM_MEDIA_TOKEN_UNITS;
  try {
    process.env.BPBATAM_MEDIA_TOKEN_UNITS = "{}";
    assert.equal((await (await invoke(subject)).json()).state, "rejected");
    assert.equal(providerCalls, before);
  } finally {
    process.env.BPBATAM_MEDIA_TOKEN_UNITS = previous;
  }
});

test("completion suppresses attribution and extracted participant dialogue until diarization is ready", async () => {
  const { meetingCompletionInput, completionMessages } =
    await import("../../src/lib/bpbatam/meetingCompletion.ts");
  const base = {
    operation: "completion",
    purpose: "summary",
    policy_revision: revision,
    question: "",
    context: {
      revision,
      segments: [],
      diarization: { configured: true, ready: false, state: "pending", code: null },
    },
  };
  const input = meetingCompletionInput.parse(base);
  assert.match(completionMessages(input)[0].content, /Diarization is not ready/);
  const ready = meetingCompletionInput.parse({
    ...base,
    context: { ...base.context, diarization: { ...base.context.diarization, ready: true } },
  });
  assert.match(
    completionMessages(ready)[0].content,
    /provider_provisional ASR speakers never confirm identity/
  );
});

test("native wallet, token-window and quota-only policy reject before a model call", async () => {
  const before = providerCalls;
  const low = await identity(119);
  const insufficient = await (await invoke(low)).json();
  assert.equal(insufficient.state, "rejected");
  assert.equal(wallet.account(low)?.balance, 119);
  const limited = await identity();
  const { upsertTokenLimit } = await import("../../src/lib/db/tokenLimits.ts");
  upsertTokenLimit({ apiKeyId: keyIds.get(limited)!, scopeType: "global", tokenLimit: 119 });
  assert.equal((await (await invoke(limited)).json()).state, "rejected");
  const providerLimited = await identity();
  upsertTokenLimit({
    apiKeyId: keyIds.get(providerLimited)!,
    scopeType: "provider",
    scopeValue: "local-speaker-fixture",
    tokenLimit: 119,
  });
  assert.equal((await (await invoke(providerLimited)).json()).state, "rejected");
  const quota = await identity();
  await keys.updateApiKeyPermissions(keyIds.get(quota)!, { allowedQuotas: ["nonexistent-pool"] });
  assert.equal((await (await invoke(quota)).json()).state, "rejected");
  assert.equal(providerCalls, before);
});

test("settled output replay and foreign receipt lookup never reconstruct or redispatch audio", async () => {
  const subject = await identity(),
    other = await identity(),
    before = providerCalls;
  const attempt = { operation_id: randomUUID(), attempt_id: randomUUID() };
  const first = await (await invoke(subject, attempt)).json();
  assert.equal(first.state, "completed");
  const replay = await (await invoke(subject, attempt)).json();
  assert.equal(replay.state, "uncertain");
  assert.equal(replay.error_code, "MEETING_PRIVATE_OUTPUT_UNAVAILABLE");
  assert.equal(replay.receipt_id, first.receipt_id);
  assert.equal(replay.segments, undefined);
  const foreign = await (await invokeStatus(other, attempt)).json();
  assert.equal(foreign.receipt_id, undefined);
  assert.equal(foreign.segments, undefined);
  assert.equal(providerCalls, before + 1);
});

test("the audited adapter cannot dispatch outside a durable native admission", async () => {
  const subject = await identity(),
    before = providerCalls;
  const stored = await keys.getApiKeyById(keyIds.get(subject)!);
  const { prepareMeetingDiarization, diarizationPolicySchema } =
    await import("../../src/lib/bpbatam/meetingDiarization.ts");
  const policy = diarizationPolicySchema.parse({
    kind: "diarization",
    revision,
    offer_id: "local-stt/speakers",
    deployments: [deployment],
  });
  const plan = await prepareMeetingDiarization(
    { ...stored, id: keyIds.get(subject)!, key: String(stored!.key) },
    policy,
    async () => policy
  );
  await assert.rejects(
    async () =>
      plan.dispatch(
        new Request(origin + "/v1/audio/diarizations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "local-stt/speakers",
            session_id: randomUUID(),
            chunk_id: randomUUID(),
            start_ms: 0,
            audio_base64: wav().toString("base64"),
          }),
        })
      ),
    /MEETING_ADMISSION_REQUIRED/
  );
  assert.equal(providerCalls, before);
});

async function invokeForget(
  subject: string,
  sessionId: string,
  deploymentId = "internal-chat",
  azp = "bpbatam-control-plane-service",
  issuer = origin
) {
  const jwt = await new SignJWT({ azp, realm_access: { roles: ["bp:meeting-infer"] } })
    .setProtectedHeader({ alg: "RS256", kid: "meeting-test" })
    .setSubject("cp-machine")
    .setIssuer(origin)
    .setAudience("meeting-tests")
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(pair.privateKey);
  return meetingInference(
    new Request(origin + "/meeting-inference", {
      method: "POST",
      headers: { Authorization: "Bearer " + jwt, "Content-Type": "application/json" },
      body: JSON.stringify({
        subject,
        issuer,
        operation: "diarization-forget",
        session_id: sessionId,
        deployment_id: deploymentId,
      }),
    })
  );
}

test("retention is bounded and forwarded into the pinned inference payload", async () => {
  const subject = await identity(),
    before = providerCalls;
  assert.equal((await (await invoke(subject, { retention_seconds: 7 })).json()).state, "completed");
  assert.equal(received.retention_seconds, 7);
  for (const retention_seconds of [0, 301, 1.5])
    assert.equal((await invoke(subject, { retention_seconds })).status, 422);
  assert.equal(providerCalls, before + 1);
});

test("machine-only nonbillable forget remains available to an inactive owner with a revoked user key", async () => {
  const subject = await identity(),
    session = randomUUID(),
    before = providerCalls,
    deletes = forgetCalls;
  wallet.setPrincipalActive(subject, false);
  await keys.updateApiKeyPermissions(keyIds.get(subject)!, { isActive: false });
  const count = () =>
    Number(
      (
        core.getDbInstance().prepare("SELECT COUNT(*) AS count FROM bp_token_admissions").get() as {
          count: number;
        }
      ).count
    );
  const admissions = count();
  for (let index = 0; index < 2; index++) {
    const response = await invokeForget(subject, session);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { forgotten: true, session_id: session });
  }
  assert.equal(count(), admissions);
  assert.equal(providerCalls, before);
  assert.equal(forgetCalls, deletes + 2);
  assert.equal(wallet.account(subject)?.balance, 100000);
  assert.equal(
    (await invokeForget(subject, session, "internal-chat", "browser-client")).status,
    403
  );
  assert.equal(
    (await invokeForget(subject, session, "internal-chat", undefined, "http://wrong.invalid"))
      .status,
    403
  );
  assert.equal(forgetCalls, deletes + 2);
});

test("forget does not claim erased data after target removal, DNS escape, redirect or mismatched confirmation", async () => {
  const subject = await identity(),
    session = randomUUID(),
    before = forgetCalls;
  assert.equal((await invokeForget(subject, session, "removed-target")).status, 409);
  const previous = deployment.ip_addresses;
  deployment.ip_addresses = ["127.0.0.2"];
  assert.equal((await invokeForget(subject, session)).status, 403);
  deployment.ip_addresses = previous;
  assert.equal(forgetCalls, before);
  for (const state of ["forget_redirect", "forget_wrong"]) {
    mode = state;
    assert.equal((await invokeForget(subject, session)).status, 503);
  }
  mode = "ready";
  assert.equal(redirects, 0);
  assert.equal(forgetCalls, before + 2);
});
