import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import type { MeetingUsageIdentity } from "../../src/lib/db/bpbatamMeetingUsage";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bp-meeting-usage-"));
process.env.DATA_DIR = directory;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.API_KEY_SECRET = "synthetic-usage-test-secret";
const pair = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(pair.publicKey)), kid: "usage-test", alg: "RS256" };
const server = http.createServer((_req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ keys: [jwk] }));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const issuer = "http://127.0.0.1:" + (server.address() as import("node:net").AddressInfo).port;
process.env.BPBATAM_OIDC_ISSUER = issuer;
process.env.BPBATAM_SERVICE_AUDIENCE = "usage-tests";
const core = await import("../../src/lib/db/core.ts");
const wallet = await import("../../src/lib/db/bpbatam.ts");
const keys = await import("../../src/lib/db/apiKeys.ts");
const { POST } = await import("../../src/app/api/bpbatam/meeting-usage/route.ts");
wallet.createAccount("bpbatam", null, "platform");

async function invoke(
  attempts: object[],
  azp = "bpbatam-control-plane-service",
  roles = ["bp:read"],
  body = JSON.stringify({ attempts })
) {
  const token = await new SignJWT({ azp, realm_access: { roles } })
    .setProtectedHeader({ alg: "RS256", kid: "usage-test" })
    .setIssuer(issuer)
    .setAudience("usage-tests")
    .setSubject("usage-reader")
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(pair.privateKey);
  return POST(
    new Request("http://localhost/api/bpbatam/meeting-usage", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body,
    })
  );
}

test("exact native attempt usage preserves provider units and is read-only on repeated delivery", async () => {
  const subject = randomUUID();
  const key = await keys.createApiKey(subject, "usage-test");
  wallet.createAccount(subject, "bpbatam", "user");
  wallet.allocate("usage-fund", null, subject, 1000, issuer);
  wallet.bindPrincipal(subject, issuer, subject, key.id);
  const operation_id = randomUUID();
  const attempt_id = randomUUID();
  const receipt_id = key.id + ":meeting:" + attempt_id;
  wallet.reserve(receipt_id, key.id, 100, "/v1/chat/completions", "private-model", [], undefined, {
    subject,
    operation_id,
    attempt_id,
    policy_revision: "a".repeat(64),
    operation_kind: "completion",
    provenance: { prompt: "private-content-marker", secret: "credential-marker" },
  });
  wallet.settle(receipt_id, 12, {
    input: 9,
    output: 3,
    total: 12,
    unit: "provider-token",
    prompt: "private-content-marker",
  });
  const identity = { subject, issuer, operation_id, attempt_id, receipt_id };
  const before = wallet.account(subject);
  const response = await invoke([identity]);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.attempts[0], {
    operation_id,
    attempt_id,
    receipt_id,
    operation_kind: "completion",
    input_kind: null,
    status: "available",
    receipt_state: "settled",
    native_unit: "provider-token",
    native_reserved: "100",
    native_actual: "12",
    provider_input_tokens: "9",
    provider_output_tokens: "3",
  });
  assert.deepEqual(await (await invoke([identity])).json(), result);
  assert.deepEqual(wallet.account(subject), before);
  wallet.setPrincipalActive(subject, false);
  assert.deepEqual(await (await invoke([identity])).json(), result);
  assert.deepEqual(wallet.account(subject), before);
  assert.doesNotMatch(
    JSON.stringify(result),
    /private-content-marker|credential-marker|private-model/
  );
});

test("new admitted attempts remain separate and an uncertain media receipt never becomes provider tokens", async () => {
  const subject = randomUUID();
  const key = await keys.createApiKey(subject, "usage-test");
  wallet.createAccount(subject, "bpbatam", "user");
  wallet.allocate("fund-" + subject, null, subject, 1000, issuer);
  wallet.bindPrincipal(subject, issuer, subject, key.id);
  const operation_id = randomUUID();
  const identities: MeetingUsageIdentity[] = [];
  for (const actual of [10, 10, null]) {
    const attempt_id = randomUUID();
    const receipt_id = key.id + ":meeting:" + attempt_id;
    wallet.reserve(receipt_id, key.id, 10, "/v1/audio/speech", "media-tts", [], undefined, {
      subject,
      operation_id,
      attempt_id,
      policy_revision: "b".repeat(64),
      operation_kind: "tts",
    });
    wallet.settle(
      receipt_id,
      actual,
      actual == null
        ? { reason: "upstream_or_handler_failure" }
        : { unit: "router-media-token-equivalent", total: 10 }
    );
    identities.push({ subject, issuer, operation_id, attempt_id, receipt_id });
  }
  const before = wallet.account(subject);
  const result = await (await invoke(identities)).json();
  assert.equal(
    new Set(result.attempts.map((row: { receipt_id: string }) => row.receipt_id)).size,
    3
  );
  assert.deepEqual(
    result.attempts.map((row: { native_actual: string | null }) => row.native_actual),
    ["10", "10", null]
  );
  for (const row of result.attempts) {
    assert.equal(row.provider_input_tokens, null);
    assert.equal(row.provider_output_tokens, null);
  }
  assert.equal(result.attempts[2].receipt_state, "uncertain");
  assert.deepEqual(await (await invoke(identities)).json(), result);
  assert.deepEqual(wallet.account(subject), before);
  assert.equal(wallet.receipts(subject).length, 3);
  assert.equal(before?.reserved, 10);
  assert.equal(before?.balance, 980);
  for (const changed of [
    { operation_id: randomUUID() },
    { subject: randomUUID() },
    { issuer: issuer + "/other" },
    { receipt_id: "unrelated-receipt" },
  ]) {
    const response = await invoke([{ ...identities[0], ...changed }]);
    assert.equal((await response.json()).attempts[0].status, "not_found");
  }
  assert.equal((await invoke(identities, "wrong-client")).status, 403);
  assert.equal(
    (await invoke(identities, "bpbatam-control-plane-service", ["bp:meeting-infer"])).status,
    403
  );
});

test("stored metadata outside the admitted operation kinds is never disclosed", async () => {
  const subject = randomUUID();
  const key = await keys.createApiKey(subject, "usage-test");
  wallet.createAccount(subject, "bpbatam", "user");
  wallet.allocate("fund-" + subject, null, subject, 100, issuer);
  wallet.bindPrincipal(subject, issuer, subject, key.id);
  const operation_id = randomUUID(),
    attempt_id = randomUUID();
  const receipt_id = key.id + ":meeting:" + attempt_id;
  wallet.reserve(receipt_id, key.id, 10, "/v1/audio/speech", "media-tts", [], undefined, {
    subject,
    operation_id,
    attempt_id,
    policy_revision: "b".repeat(64),
    operation_kind: "PRIVATE_OPERATION_MARKER",
  });
  const response = await invoke([{ subject, issuer, operation_id, attempt_id, receipt_id }]);
  const value = await response.json();
  assert.equal(value.attempts[0].status, "not_found");
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_OPERATION_MARKER/);
});

test("question ASR projects only its canonical input kind and no private provenance", async () => {
  const subject = randomUUID();
  const key = await keys.createApiKey(subject, "usage-test");
  wallet.createAccount(subject, "bpbatam", "user");
  wallet.allocate("fund-" + subject, null, subject, 1000, issuer);
  wallet.bindPrincipal(subject, issuer, subject, key.id);
  const operation_id = randomUUID(),
    attempt_id = randomUUID();
  const receipt_id = key.id + ":meeting:" + attempt_id;
  wallet.reserve(receipt_id, key.id, 20, "/v1/audio/transcriptions", "media-stt", [], undefined, {
    subject,
    operation_id,
    attempt_id,
    policy_revision: "b".repeat(64),
    operation_kind: "stt",
    provenance: { input_kind: "question", question: "PRIVATE_VOICE_MARKER" },
  });
  wallet.settle(receipt_id, 20, { unit: "router-media-token-equivalent", total: 20 });
  const result = await (
    await invoke([{ subject, issuer, operation_id, attempt_id, receipt_id }])
  ).json();
  assert.equal(result.attempts[0].input_kind, "question");
  assert.equal(result.attempts[0].native_actual, "20");
  assert.equal(result.attempts[0].provider_input_tokens, null);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_VOICE_MARKER/);
});

test("usage failures emit only a fixed category, never caller content or exception text", async (t) => {
  const warning = t.mock.method(console, "warn", () => {});
  const response = await invoke([], undefined, undefined, '{"PRIVATE_USAGE_MARKER":');
  assert.equal(response.status, 503);
  assert.equal(warning.mock.callCount(), 1);
  assert.deepEqual(warning.mock.calls[0].arguments, [
    "[MEETING_USAGE] Query unavailable",
    { category: "usage_query_failed" },
  ]);
  assert.doesNotMatch(
    JSON.stringify(warning.mock.calls[0].arguments),
    /PRIVATE_USAGE_MARKER|SyntaxError|stack/
  );
});

test("malformed stored provenance stays unavailable with safe attempt correlation", async (t) => {
  const subject = randomUUID();
  const key = await keys.createApiKey(subject, "usage-test");
  wallet.createAccount(subject, "bpbatam", "user");
  wallet.allocate("fund-" + subject, null, subject, 100, issuer);
  wallet.bindPrincipal(subject, issuer, subject, key.id);
  const operation_id = randomUUID(),
    attempt_id = randomUUID();
  const receipt_id = key.id + ":meeting:" + attempt_id;
  wallet.reserve(receipt_id, key.id, 10, "/v1/audio/speech", "media-tts", [], undefined, {
    subject,
    operation_id,
    attempt_id,
    policy_revision: "b".repeat(64),
    operation_kind: "tts",
  });
  // Corrupt persisted external metadata, then observe only the authenticated public projection.
  core
    .getDbInstance()
    .prepare("UPDATE bp_meeting_attempts SET provenance_json=? WHERE attempt_id=?")
    .run('{"PRIVATE_PROVENANCE_MARKER":', attempt_id);
  const warning = t.mock.method(console, "warn", () => {});
  const response = await invoke([{ subject, issuer, operation_id, attempt_id, receipt_id }]);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).attempts[0].status, "not_found");
  assert.deepEqual(warning.mock.calls[0]?.arguments, [
    "[MEETING_USAGE] Stored provenance unavailable",
    { category: "invalid_provenance_json", operation_id, attempt_id },
  ]);
  assert.doesNotMatch(
    JSON.stringify(warning.mock.calls.map((call) => call.arguments)),
    /PRIVATE_PROVENANCE_MARKER|SyntaxError|stack/
  );
});

test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  core.resetDbInstance();
  fs.rmSync(directory, { recursive: true, force: true });
});
