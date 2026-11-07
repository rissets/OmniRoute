import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bp-uncertain-admission-"));
process.env.DATA_DIR = directory;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const core = await import("../../src/lib/db/core.ts");
const wallet = await import("../../src/lib/db/bpbatam.ts");
const quotas = await import("../../src/lib/db/bpbatamQuotas.ts");
const { holdUnsettled } = await import("../../src/lib/bpbatam/context.ts");
const priorPolicy = process.env.BPBATAM_UNCERTAIN_USAGE_POLICY;
let sequence = 0;

function account(balance = 2000) {
  const id = "uncertain-user-" + ++sequence;
  wallet.createAccount(id, null, "user");
  wallet.allocate("grant-" + id, null, id, balance, "issuer");
  wallet.bindPrincipal(id, "issuer", id, id);
  wallet.reserve("failed-" + id, id, 500, "/v1/chat/completions", "flash", []);
  wallet.settle("failed-" + id, null, { reason: "upstream_or_handler_failure" });
  return id;
}

test.after(() => {
  if (priorPolicy == null) delete process.env.BPBATAM_UNCERTAIN_USAGE_POLICY;
  else process.env.BPBATAM_UNCERTAIN_USAGE_POLICY = priorPolicy;
  core.resetDbInstance();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("strict reconciliation remains the default, including unknown policy values", () => {
  for (const policy of [undefined, "block", "invalid"]) {
    if (policy == null) delete process.env.BPBATAM_UNCERTAIN_USAGE_POLICY;
    else process.env.BPBATAM_UNCERTAIN_USAGE_POLICY = policy;
    const id = account();
    assert.throws(() => wallet.reserve("next-" + id, id, 300, "/v1/chat/completions", "ice", []), {
      message: "ACCOUNT_RECONCILIATION_REQUIRED",
    });
  }
});

test("hold policy permits another model without refunding unknown provider usage", () => {
  process.env.BPBATAM_UNCERTAIN_USAGE_POLICY = "hold";
  const id = account();
  wallet.reserve("next-" + id, id, 300, "/v1/chat/completions", "ice", []);
  wallet.settle("next-" + id, 100, { total: 100, unit: "provider-token" });
  assert.equal(wallet.account(id)?.balance, 1900);
  assert.equal(wallet.account(id)?.reserved, 500);
  assert.equal(wallet.admission("failed-" + id)?.state, "uncertain");
  assert.equal(wallet.admission("failed-" + id)?.actual, null);
  wallet.settle("failed-" + id, 250, { total: 250, unit: "provider-token" });
  assert.equal(wallet.account(id)?.balance, 1650);
  assert.equal(wallet.account(id)?.reserved, 0);
  assert.equal(wallet.journalBalance(), 0);
});

test("hold policy cannot spend held tokens, including after restart", () => {
  process.env.BPBATAM_UNCERTAIN_USAGE_POLICY = "hold";
  const id = account(1000);
  core.resetDbInstance();
  assert.throws(
    () => wallet.reserve("too-large-" + id, id, 501, "/v1/chat/completions", "ice", []),
    { message: "INSUFFICIENT_TOKENS" }
  );
  wallet.reserve("last-" + id, id, 500, "/v1/chat/completions", "ice", []);
  assert.equal(wallet.account(id)?.reserved, 1000);
  assert.throws(() => wallet.reserve("overspend-" + id, id, 1, "/v1/chat/completions", "ice", []), {
    message: "INSUFFICIENT_TOKENS",
  });
});

test("hold policy still counts uncertain reservations against user window limits", () => {
  process.env.BPBATAM_UNCERTAIN_USAGE_POLICY = "hold";
  const id = account();
  quotas.changeUserLimits("limit-" + id, id, quotas.userLimits(id).revision, {
    limits: [{ window: "5h", tokens: 600 }],
  });
  assert.throws(
    () => wallet.reserve("over-window-" + id, id, 101, "/v1/chat/completions", "ice", []),
    { message: "USER_TOKEN_WINDOW_EXHAUSTED" }
  );
  wallet.reserve("in-window-" + id, id, 100, "/v1/chat/completions", "ice", []);
  assert.equal(wallet.account(id)?.reserved, 600);
});

test("hold policy still blocks known provider usage exceeding its held reservation", () => {
  process.env.BPBATAM_UNCERTAIN_USAGE_POLICY = "hold";
  const id = account(1000);
  wallet.settle("failed-" + id, 1200, { total: 1200, unit: "provider-token" });
  holdUnsettled("failed-" + id, "upstream_or_handler_failure");
  assert.throws(
    () => wallet.reserve("known-overage-" + id, id, 100, "/v1/chat/completions", "ice", []),
    { message: "ACCOUNT_RECONCILIATION_REQUIRED" }
  );
});

test("hold policy fails closed for unknown reconciliation reasons", () => {
  process.env.BPBATAM_UNCERTAIN_USAGE_POLICY = "hold";
  const id = account();
  wallet.settle("failed-" + id, null, { reason: "unknown_reason" });
  assert.throws(
    () => wallet.reserve("unknown-reason-" + id, id, 100, "/v1/chat/completions", "ice", []),
    { message: "ACCOUNT_RECONCILIATION_REQUIRED" }
  );
});

test("hold policy keeps a fixed-unit ASR reservation without blocking the next meeting or chat", () => {
  process.env.BPBATAM_UNCERTAIN_USAGE_POLICY = "hold";
  const id = "uncertain-asr-" + ++sequence;
  wallet.createAccount(id, null, "user");
  wallet.allocate("grant-" + id, null, id, 1000, "issuer");
  wallet.bindPrincipal(id, "issuer", id, id);
  wallet.reserve("failed-" + id, id, 20, "/v1/audio/transcriptions", "local-stt/media-stt", []);
  wallet.settle("failed-" + id, null, { reason: "upstream_or_handler_failure" });
  core.resetDbInstance();
  wallet.reserve("next-asr-" + id, id, 20, "/v1/audio/transcriptions", "local-stt/media-stt", []);
  wallet.settle("next-asr-" + id, 20, { total: 20, unit: "router-media-token-equivalent" });
  wallet.reserve("next-chat-" + id, id, 100, "/v1/chat/completions", "flash", []);
  assert.equal(wallet.admission("failed-" + id)?.state, "uncertain");
  assert.equal(wallet.admission("failed-" + id)?.actual, null);
  assert.equal(wallet.account(id)?.reserved, 120);
  assert.equal(wallet.account(id)?.balance, 980);
  assert.throws(
    () => wallet.reserve("overspend-" + id, id, 861, "/v1/chat/completions", "flash", []),
    {
      message: "INSUFFICIENT_TOKENS",
    }
  );
});
