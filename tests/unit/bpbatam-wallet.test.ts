import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const data = fs.mkdtempSync(path.join(os.tmpdir(), "bp-wallet-"));
process.env.DATA_DIR = data;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const core = await import("../../src/lib/db/core.ts");
const w = await import("../../src/lib/db/bpbatam.ts");
const usage = await import("../../src/lib/bpbatam/usage.ts");
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(data, { recursive: true, force: true });
});
test("permanent allocation, reservation, replay and rollback conserve tokens", () => {
  w.createAccount("root", null, "platform");
  w.createAccount("dept", "root", "department");
  w.createAccount("user", "dept", "user");
  w.allocate("grant", null, "root", 2000, "issuer");
  w.allocate("dept-allocation", "root", "dept", 1000, "admin");
  w.allocate("user-allocation", "dept", "user", 1000, "operator");
  assert.equal(w.allocate("user-allocation", "dept", "user", 1000, "operator"), "replayed");
  assert.throws(() => w.allocate("user-allocation", "dept", "user", 1001, "operator"));
  w.bindPrincipal("subject", "issuer", "user", "key");
  let accepted = 0;
  for (let i = 0; i < 100; i++) {
    try {
      w.reserve("r" + i, "key", 30, "/v1/chat/completions", "test", []);
      accepted++;
    } catch (e) {
      assert.equal((e as Error).message, "INSUFFICIENT_TOKENS");
    }
  }
  assert.equal(accepted, 33);
  assert.equal(w.account("user")?.reserved, 990);
  for (let i = 0; i < 33; i++) {
    w.settle("r" + i, 20);
    assert.equal(w.settle("r" + i, 20), "replayed");
  }
  assert.equal(w.account("user")?.balance, 340);
  assert.equal(w.account("user")?.reserved, 0);
  w.reserve("missing", "key", 30, "/v1/chat/completions", "test", []);
  assert.equal(w.settle("missing", null), "uncertain");
  assert.equal(w.account("user")?.reserved, 30);
  core.resetDbInstance();
  assert.equal(w.account("user")?.reserved, 30);
  assert.equal(w.journalBalance(), 0);
  assert.ok(w.within("user", "root"));
  assert.ok(!w.within("root", "user"));
});
test("canonical totals support OpenAI, Anthropic and Gemini without overlap", () => {
  assert.equal(
    usage.canonicalUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      completion_tokens_details: { reasoning_tokens: 20 },
    })?.total,
    150
  );
  assert.equal(
    usage.canonicalUsage({
      input_tokens: 60,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 10,
      output_tokens: 50,
    })?.total,
    150
  );
  assert.equal(
    usage.canonicalUsage({
      promptTokenCount: 100,
      candidatesTokenCount: 30,
      thoughtsTokenCount: 20,
      totalTokenCount: 150,
    })?.total,
    150
  );
  assert.equal(usage.canonicalUsage({}), null);
  assert.equal(
    usage.canonicalUsage({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 170 }),
    null
  );
});

test("unsafe totals and self-transfers leave balances and journal unchanged", () => {
  w.createAccount("large", null, "platform");
  w.allocate("large-opening", null, "large", Number.MAX_SAFE_INTEGER, "issuer");
  assert.throws(() => w.allocate("overflow", null, "large", 1, "issuer"));
  assert.throws(() => w.allocate("self", "large", "large", 1, "issuer"));
  assert.equal(w.account("large")?.balance, Number.MAX_SAFE_INTEGER);
  assert.equal(w.journalBalance(), 0);
});

test("trusted provider usage expands an underestimated reservation only within available allocation", () => {
  w.createAccount("overhead-root", null, "platform");
  w.createAccount("overhead-user", "overhead-root", "user");
  w.allocate("overhead-issue", null, "overhead-user", 2000, "owner");
  w.bindPrincipal("overhead-subject", "https://idp.test", "overhead-user", "overhead-key");
  w.reserve("overhead-receipt", "overhead-key", 221, "/v1/chat/completions", "model", []);
  w.settle("overhead-receipt", 1060, {
    input: 1044,
    output: 16,
    total: 1060,
    unit: "provider-token",
  });
  assert.equal(w.admission("overhead-receipt")?.state, "settled");
  assert.equal(w.account("overhead-user")?.balance, 940);
  assert.equal(w.account("overhead-user")?.reserved, 0);
  assert.equal(w.journalBalance(), 0);
});
