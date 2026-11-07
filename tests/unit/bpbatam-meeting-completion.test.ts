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
let templateOptions: unknown;
let requestEncoding: string | undefined;
let providerToolChoice: unknown;
let replyToolCalls: unknown;
let providerSegments: Array<{ id: string; revision: number; human_corrected?: boolean }> = [];
let redirectCalls = 0;
let mode = "ok";
const revision = "b".repeat(64);
let deployment: Record<string, unknown>;
let selectedOffer = "meeting-test/chat";
const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url?.endsWith("/certs")) return res.end(JSON.stringify({ keys: [jwk] }));
  if (req.url?.endsWith("/token"))
    return res.end(JSON.stringify({ access_token: "machine-test", expires_in: 300 }));
  if (req.url === "/settings") return res.end(JSON.stringify({ revision }));
  if (req.url?.startsWith("/meeting-policy"))
    return res.end(
      JSON.stringify({
        kind: "completion",
        revision,
        offer_id: selectedOffer,
        deployments: [deployment],
      })
    );
  if (req.url === "/leak") {
    redirectCalls++;
    return res.end("{}");
  }
  if (req.url === "/v1/chat/completions") {
    providerCalls++;
    requestEncoding = req.headers["accept-encoding"];
    let body = "";
    for await (const chunk of req) body += chunk;
    assert.equal(JSON.parse(body).model, "chat");
    assert.equal(JSON.parse(body).stream, false);
    assert.equal(JSON.parse(body).tools, undefined);
    providerToolChoice = JSON.parse(body).tool_choice;
    templateOptions = JSON.parse(body).chat_template_kwargs;
    providerSegments = JSON.parse(JSON.parse(body).messages[1].content).context.segments;
    if (mode === "redirect") {
      res.statusCode = 307;
      res.setHeader("Location", "/leak");
      return res.end("{}");
    }
    if (mode === "failure") {
      res.statusCode = 503;
      return res.end("{}");
    }
    return res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              ...(replyToolCalls === undefined ? {} : { tool_calls: replyToolCalls }),
              content: JSON.stringify({
                answer: "Friday pilot",
                citations: [],
                summary: [],
                decisions: [],
                unresolved: [],
                actions: [],
                unknowns: [],
              }),
            },
          },
        ],
        ...(mode === "missing-usage"
          ? {}
          : { usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }),
      })
    );
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
const providers = await import("../../src/lib/db/providers.ts");
const models = await import("../../src/lib/db/models.ts");
const offers = await import("../../src/lib/bpbatam/offers.ts");
const { meetingInference } = await import("../../src/lib/bpbatam/meeting.ts");
test("meeting context carries saved notes and dialogue without accepting extra instructions", async () => {
  const { meetingCompletionInput, completionMessages } =
    await import("../../src/lib/bpbatam/meetingCompletion.ts");
  const input = {
    operation: "completion",
    purpose: "answer",
    policy_revision: "a".repeat(64),
    question: "Apa maksud catatan saya?",
    context: {
      revision: "b".repeat(64),
      segments: [],
      notes: {
        id: "39e09384-f6d4-48ab-b413-91c692a93218",
        revision: 2,
        text: "Anggaran alternatif 25 juta",
      },
      speaker_names: { revision: 1, names: { speaker_1: "Rina" } },
      chat_turns: [
        {
          operation_id: "ce70655f-836a-4e96-81dc-51917775537b",
          question: "Apa alternatifnya?",
          answer: "Belum diputuskan.",
        },
      ],
    },
  };
  const parsed = meetingCompletionInput.parse(input);
  const sent = JSON.parse(completionMessages(parsed)[1].content);
  assert.equal(sent.context.notes.text, "Anggaran alternatif 25 juta");
  assert.match(sent.task, /answer.*question/i);
  assert.match(sent.task, /untrusted/i);
  assert.ok(Array.isArray(sent.output_schema.enhanced_notes));
  assert.ok(Array.isArray(sent.output_schema.summary));
  assert.equal(sent.output_schema.enhanced_notes[0].citations[0].revision, 1);
  assert.ok(completionMessages(parsed)[0].content.includes(JSON.stringify(sent.output_schema)));
  assert.equal(sent.context.chat_turns[0].answer, "Belum diputuskan.");
  assert.match(completionMessages(parsed)[0].content, /private notes/i);
  assert.equal(
    meetingCompletionInput.safeParse({
      ...input,
      context: { ...input.context, tool_instructions: "send outside" },
    }).success,
    false
  );
  assert.equal(
    meetingCompletionInput.safeParse({
      ...input,
      context: { ...input.context, chat_turns: Array(21).fill(input.context.chat_turns[0]) },
    }).success,
    false
  );
});
await providers.createProviderNode({
  id: "openai-compatible-chat-meeting-test",
  prefix: "meeting-test",
  apiType: "chat",
  type: "openai-compatible",
  name: "Meeting fixture",
  baseUrl: origin + "/v1",
});
await models.addCustomModel("openai-compatible-chat-meeting-test", "chat");
const connection = await providers.createProviderConnection({
  provider: "openai-compatible-chat-meeting-test",
  authType: "apikey",
  apiKey: "synthetic-provider-key",
  isActive: true,
  proxyEnabled: false,
  perKeyProxyEnabled: false,
  providerSpecificData: {
    baseUrl: origin + "/v1",
    prefix: "meeting-test",
    apiType: "chat",
    nodeName: "Meeting fixture",
    autoFetchModels: false,
  },
});
deployment = {
  id: "internal-chat",
  label: "Internal test",
  kind: "completion",
  base_url: origin + "/v1",
  provider: "openai-compatible-chat-meeting-test",
  connection_id: connection.id,
  model: "chat",
  ip_addresses: ["127.0.0.1"],
  attestation_id: "test-only",
  adapter_version: "openai-chat-v1",
  model_version: "test-v1",
};
wallet.createAccount("bpbatam", null, "platform");
let sequence = 0;
async function identity() {
  const subject = "member-" + ++sequence;
  const key = await keys.createApiKey(subject, "meeting-test");
  wallet.createAccount(subject, "bpbatam", "user");
  wallet.allocate("fund-" + subject, null, subject, 100000, origin);
  wallet.bindPrincipal(subject, origin, subject, key.id);
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
        operation: "completion",
        operation_id: randomUUID(),
        attempt_id: randomUUID(),
        policy_revision: revision,
        purpose: "answer",
        context: { revision: "a".repeat(64), segments: [] },
        question: "What is decided?",
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

test("trusted meeting completion admits one pinned physical call and settles native provider tokens", async () => {
  const subject = await identity();
  const response = await invoke(subject);
  assert.equal(response.status, 200, await response.clone().text());
  const value = await response.json();
  assert.equal(value.state, "completed");
  assert.equal(value.receipt_state, "settled");
  assert.equal(value.destination_url, origin + "/v1/chat/completions");
  assert.equal(value.ip_address, "127.0.0.1");
  assert.equal(value.transport, "direct-pinned");
  assert.equal(wallet.admission(value.receipt_id)?.actual, 30);
  assert.equal(wallet.account(subject)?.balance, 99970);
  assert.equal(providerCalls, 1);
  assert.equal(templateOptions, undefined);
  assert.equal(providerToolChoice, "none");
});

test("an explicitly selected non-thinking adapter uses one pinned accounted completion", async () => {
  const subject = await identity();
  const previous = deployment.adapter_version;
  const before = providerCalls;
  deployment.adapter_version = "qwen-chat-no-thinking-v1";
  try {
    const response = await invoke(subject);
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.state, "completed");
    assert.equal(value.receipt_state, "settled");
    assert.equal(value.adapter_version, "qwen-chat-no-thinking-v1");
    assert.deepEqual(templateOptions, { enable_thinking: false });
    assert.equal(providerCalls, before + 1);
    assert.equal(wallet.admission(value.receipt_id)?.actual, 30);
  } finally {
    deployment.adapter_version = previous;
  }
});

test("an explicit empty tool-call list is a plain completion, while actual tool calls are rejected", async () => {
  try {
    replyToolCalls = [];
    const accepted = await invoke(await identity());
    const result = await accepted.json();
    assert.equal(result.state, "completed");
    assert.equal(result.receipt_state, "settled");
    replyToolCalls = [{ id: "forbidden-tool", type: "function", function: { name: "external" } }];
    const denied = await invoke(await identity());
    assert.equal((await denied.json()).state, "uncertain");
  } finally {
    replyToolCalls = undefined;
  }
});

test("an HTTP 200 without usage is uncertain and a same-attempt replay makes no second call", async () => {
  const subject = await identity();
  mode = "missing-usage";
  const attempt = { operation_id: randomUUID(), attempt_id: randomUUID() };
  const before = providerCalls;
  const first = await (await invoke(subject, attempt)).json();
  assert.equal(first.state, "uncertain");
  assert.equal(first.receipt_state, "uncertain");
  const replay = await (await invoke(subject, attempt)).json();
  assert.equal(replay.receipt_id, first.receipt_id);
  assert.equal(providerCalls, before + 1);
  mode = "ok";
});

test("an explicit new question preserves human correction provenance at the provider edge", async () => {
  const subject = await identity();
  const segment = {
    id: randomUUID(),
    revision: 2,
    text: "Owner corrected this passage.",
    start_ms: 0,
    end_ms: 1000,
    speaker: null,
    state: "stable",
    human_corrected: true,
  };
  const response = await invoke(subject, {
    context: { revision: "c".repeat(64), segments: [segment] },
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).state, "completed");
  assert.deepEqual(providerSegments, [segment]);
});

test("forged executor identity and changed policy never send meeting content", async () => {
  const subject = await identity();
  const before = providerCalls;
  assert.equal((await invoke(subject, {}, "browser-client")).status, 403);
  assert.equal((await invoke(subject, { policy_revision: "c".repeat(64) })).status, 409);
  assert.equal(providerCalls, before);
});

test("DNS address escape is rejected before physical dispatch with a released zero receipt", async () => {
  const subject = await identity();
  const before = providerCalls;
  const dnsBase = origin.replace("127.0.0.1", "localhost") + "/v1";
  await providers.updateProviderNode("openai-compatible-chat-meeting-test", { baseUrl: dnsBase });
  await providers.updateProviderConnection(connection.id, {
    providerSpecificData: {
      baseUrl: dnsBase,
      prefix: "meeting-test",
      apiType: "chat",
      nodeName: "Meeting fixture",
      autoFetchModels: false,
    },
  });
  deployment.base_url = dnsBase;
  deployment.ip_addresses = ["127.0.0.2"];
  const value = await (await invoke(subject)).json();
  assert.equal(value.state, "rejected");
  assert.equal(value.receipt_state, "settled");
  assert.equal(wallet.admission(value.receipt_id)?.actual, 0);
  assert.equal(providerCalls, before);
  deployment.ip_addresses = ["127.0.0.1"];
  deployment.base_url = origin + "/v1";
  await providers.updateProviderConnection(connection.id, {
    providerSpecificData: {
      baseUrl: origin + "/v1",
      prefix: "meeting-test",
      apiType: "chat",
      nodeName: "Meeting fixture",
      autoFetchModels: false,
    },
  });
  await providers.updateProviderNode("openai-compatible-chat-meeting-test", {
    baseUrl: origin + "/v1",
  });
});

test("provider redirects and failures retain one uncertain attempt without following or retrying", async () => {
  for (const failure of ["redirect", "failure"]) {
    const subject = await identity();
    const before = providerCalls;
    mode = failure;
    const value = await (await invoke(subject)).json();
    assert.equal(value.state, "uncertain");
    assert.equal(value.receipt_state, "uncertain");
    assert.equal(providerCalls, before + 1);
    assert.equal(wallet.admission(value.receipt_id)?.actual, null);
    assert.equal(redirectCalls, 0);
  }
  mode = "ok";
});

test("connection URL drift and proxy configuration are denied before content dispatch", async () => {
  const subject = await identity();
  const before = providerCalls;
  await providers.updateProviderConnection(connection.id, {
    providerSpecificData: { baseUrl: "https://outside.invalid/v1" },
  });
  assert.equal((await invoke(subject)).status, 403);
  await providers.updateProviderConnection(connection.id, {
    providerSpecificData: {},
    proxyEnabled: true,
  });
  assert.equal((await invoke(subject)).status, 403);
  assert.equal(providerCalls, before);
  await providers.updateProviderConnection(connection.id, {
    providerSpecificData: {},
    proxyEnabled: false,
  });
});

test("a priority Combo preserves connection pins and never hides a second provider call", async () => {
  const combos = await import("../../src/lib/db/combos.ts");
  const combo = await combos.createCombo({
    name: "meeting-priority",
    strategy: "priority",
    models: [
      { model: "meeting-test/chat", connectionId: connection.id },
      { model: "meeting-test/chat", connectionId: "not-permitted" },
    ],
  });
  const subject = await identity();
  const before = providerCalls;
  mode = "failure";
  const old = deployment;
  // The policy origin selects the Combo; all concrete connection pins still apply.
  selectedOffer = "meeting-priority";
  const value = await (await invoke(subject)).json();
  assert.equal(value.state, "uncertain");
  assert.equal(providerCalls, before + 1);
  selectedOffer = "meeting-test/chat";
  deployment = old;
  mode = "ok";
  await combos.deleteCombo(combo.id);
});

test("combo gateway identity encoding works without allowing arbitrary connection headers", async () => {
  const before = providerCalls;
  const original = (await providers.getProviderConnectionById(connection.id))!.providerSpecificData;
  try {
    await providers.updateProviderConnection(connection.id, {
      providerSpecificData: { ...original, customHeaders: { "Accept-Encoding": "identity" } },
    });
    const response = await invoke(await identity());
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).state, "completed");
    assert.equal(providerCalls, before + 1);
    assert.equal(requestEncoding, "identity");
    await providers.updateProviderConnection(connection.id, {
      providerSpecificData: { ...original, customHeaders: { "X-External-Route": "not-permitted" } },
    });
    assert.equal((await invoke(await identity())).status, 403);
    assert.equal(providerCalls, before + 1);
  } finally {
    await providers.updateProviderConnection(connection.id, {
      providerSpecificData: { ...original, customHeaders: null },
    });
  }
});

test("notes enhancement rejects transcript and unrelated context", async () => {
  const { meetingCompletionInput, completionMessages } =
    await import("../../src/lib/bpbatam/meetingCompletion.ts");
  const body = {
    operation: "completion",
    purpose: "enhance",
    policy_revision: "a".repeat(64),
    question: "",
    context: {
      revision: "b".repeat(64),
      segments: [],
      notes: {
        id: "39e09384-f6d4-48ab-b413-91c692a93218",
        revision: 1,
        text: "kopi",
      },
    },
  };
  const parsed = meetingCompletionInput.parse(body);
  assert.match(completionMessages(parsed)[0].content, /do not add facts/i);
  assert.equal(
    meetingCompletionInput.safeParse({
      ...body,
      context: {
        ...body.context,
        speaker_names: { revision: 1, names: {} },
      },
    }).success,
    false
  );
  assert.equal(
    meetingCompletionInput.safeParse({
      ...body,
      context: {
        ...body.context,
        notes: { ...body.context.notes, text: "  " },
      },
    }).success,
    false
  );
});
