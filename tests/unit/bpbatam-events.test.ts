import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const data = fs.mkdtempSync(path.join(os.tmpdir(), "bp-events-"));
process.env.DATA_DIR = data;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const core = await import("../../src/lib/db/core.ts");
const wallet = await import("../../src/lib/db/bpbatam.ts");
const events = await import("../../src/lib/db/bpbatamEvents.ts");
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(data, { recursive: true, force: true });
});
test("audio duration is projected as usage while financial fields remain private", () => {
  assert.deepEqual(
    events.safeUsage({
      total: 20,
      unit: "router-media-token-equivalent",
      audio_seconds: 3.171,
      costUsd: 4,
      api_key: "private",
    }),
    { total: 20, audio_seconds: 3.171, unit: "router-media-token-equivalent" }
  );
  assert.deepEqual(events.safeUsage({ audio_seconds: Infinity }), {});
  assert.deepEqual(events.safeUsage({ audio_seconds: -1 }), {});
  assert.deepEqual(events.safeUsage({ evidence_reference: "provider-request-20261026-0042" }), {
    evidence_reference: "provider-request-20261026-0042",
  });
  assert.deepEqual(
    events.safeUsage({ evidence_reference: "https://example.invalid/?token=x" }),
    {}
  );
});
test("department and policy context is pinned at atomic admission and survives movement", () => {
  wallet.createAccount("bpbatam", null, "platform");
  wallet.createAccount("a", "bpbatam", "department");
  wallet.createAccount("b", "bpbatam", "department");
  wallet.createAccount("user", "a", "user");
  wallet.allocate("opening", null, "user", 1000, "owner");
  wallet.bindPrincipal("sub", "issuer", "user", "key");
  wallet.applyPolicy("sub", [], "dept-a", 2, "a");
  wallet.reserve("r1", "key", 200, "/v1/chat/completions", "model", [], 2);
  wallet.settle("r1", 150, { input: 100, output: 50, total: 150 });
  wallet.applyPolicy("sub", [], "dept-b", 3, "b");
  assert.throws(() => wallet.reserve("stale", "key", 200, "/v1/chat/completions", "model", [], 2));
  wallet.reserve("r2", "key", 200, "/v1/chat/completions", "model", [], 3);
  wallet.settle("r2", 150);
  const first = events.operationalEvents(0, 500, "bpbatam");
  const requests = first.events.filter((e) => e.kind === "request.settled");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].payload.department_id, "dept-a");
  assert.equal(requests[1].payload.department_id, "dept-b");
  assert.equal(wallet.account("user")?.balance, 700);
  assert.equal(wallet.account("user")?.parent_id, "b");
  assert.equal(wallet.journalBalance(), 0);
  assert.equal(
    events.operationalEvents(Number(first.next_cursor), 500, "bpbatam").events.length,
    0
  );
});

test("policy denial is monitored without reserving or consuming a token", () => {
  const owner = wallet.principalForKey("key")!;
  const before = wallet.account("user")!;
  const id = events.deniedRequest(
    owner,
    "key",
    "/v1/chat/completions",
    "unassigned-model",
    "MODEL_NOT_ASSIGNED"
  );
  const row = events
    .operationalEvents(0, 500, "bpbatam")
    .events.find((e) => e.payload.request_id === id)!;
  assert.equal(row.kind, "request.denied");
  assert.equal(row.payload.usage.unit, "not-dispatched");
  assert.deepEqual(wallet.account("user"), before);
  assert.equal(row.payload.actual, 0);
});

test("uncertain account admission settles only through a referenced owner attestation", () => {
  wallet.createAccount("bpbatam", null, "platform");
  wallet.createAccount("department", "bpbatam", "department");
  wallet.createAccount("member", "department", "user");
  wallet.allocate("opening-reconcile", null, "member", 1000, "owner");
  wallet.bindPrincipal("member-subject", "issuer", "member", "member-key");
  wallet.reserve("uncertain-receipt", "member-key", 100, "/v1/chat/completions", "model", []);
  wallet.settle("uncertain-receipt", null, { reason: "provider_usage_missing_or_estimated" });

  assert.throws(() =>
    wallet.reserve("blocked-request", "member-key", 10, "/v1/chat/completions", "model", [])
  );
  assert.equal(
    wallet.reconcile(
      "cp:reconcile-command",
      "uncertain-receipt",
      64,
      "operator-service",
      "Provider receipt confirms the final token usage",
      "provider-request-20261026-0042"
    ),
    "settled"
  );

  const receiptEvents = events
    .operationalEvents(0, 500, "bpbatam")
    .events.filter((event) => event.payload.request_id === "uncertain-receipt");
  const receipt = receiptEvents.at(-1);
  assert.equal(receipt?.payload.state, "settled");
  assert.equal(receipt?.payload.actual, 64);
  assert.equal(receipt?.payload.usage.evidence_reference, "provider-request-20261026-0042");
  assert.equal(wallet.account("member")?.balance, 936);
  assert.equal(wallet.account("member")?.reserved, 0);
  wallet.reserve(
    "resumed-after-reconciliation",
    "member-key",
    10,
    "/v1/chat/completions",
    "model",
    []
  );
  wallet.settle("resumed-after-reconciliation", 10);
  assert.equal(wallet.account("member")?.balance, 926);
});
