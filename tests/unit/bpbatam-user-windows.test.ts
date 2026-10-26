import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bp-windows-"));
process.env.DATA_DIR = directory;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const core = await import("../../src/lib/db/core.ts");
const w = await import("../../src/lib/db/bpbatam.ts");
const q = await import("../../src/lib/db/bpbatamQuotas.ts");
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(directory, { recursive: true, force: true });
});
test("pool issuance is capped cumulatively while internal allocation does not mint", () => {
  w.createAccount("bpbatam", null, "platform");
  w.allocate("old", null, "bpbatam", 1000, "owner");
  q.setPoolCap("bpbatam", 1000000000);
  w.allocate("opening", null, "bpbatam", 999999000, "owner");
  assert.equal(q.poolStatus("bpbatam").issued, "1000000000");
  assert.throws(
    () => w.allocate("excess", null, "bpbatam", 1, "owner"),
    /BPBATAM_POOL_ISSUANCE_EXHAUSTED/
  );
  w.createAccount("dept", "bpbatam", "department");
  w.allocate("dept", "bpbatam", "dept", 10000000, "owner");
  w.createAccount("user", "dept", "user");
  w.allocate("user", "dept", "user", 5000000, "owner");
  w.bindPrincipal("subject", "issuer", "user", "primary");
  w.bindSubjectKey("subject", "child", "child-command", "Child");
  assert.equal(q.poolStatus("bpbatam").issued, "1000000000");
  w.createAccount("foreign", null, "platform");
  w.allocate("foreign", null, "foreign", 10, "owner");
  assert.throws(
    () => w.allocate("cross", "foreign", "bpbatam", 1, "owner"),
    /CROSS_POOL_TRANSFER_DENIED/
  );
});
test("all three windows are account-scoped, survive rollover and reset without refilling balance", () => {
  const original = Date.now;
  let now = original();
  Date.now = () => now;
  try {
    const config = (a: number, b: number, c: number) => [
      { window: "5h" as const, tokens: a },
      { window: "7d" as const, tokens: b },
      { window: "30d" as const, tokens: c },
    ];
    q.changeUserLimits("config", "user", 0, { limits: config(100, 200, 300) });
    w.reserve("r1", "primary", 50, "/v1/chat/completions", "model", []);
    assert.throws(
      () => w.reserve("r2", "child", 60, "/v1/chat/completions", "model", []),
      /USER_TOKEN_WINDOW_EXHAUSTED/
    );
    assert.throws(
      () => q.changeUserLimits("reset-pending", "user", 1, { reset: ["5h"] }),
      /PENDING_RECEIPTS_PREVENT_LIMIT_RESET/
    );
    w.settle("r1", 40);
    q.changeUserLimits("raise", "user", 1, { limits: config(150, 200, 300) });
    assert.equal(q.userLimits("user").windows[0].used, "40");
    w.reserve("r3", "child", 100, "/v1/chat/completions", "model", []);
    w.settle("r3", 90);
    now += 18000001;
    assert.equal(q.userLimits("user").windows[0].used, "0");
    assert.throws(
      () => w.reserve("weekly", "primary", 80, "/v1/chat/completions", "model", []),
      /USER_TOKEN_WINDOW_EXHAUSTED/
    );
    q.changeUserLimits("raise-week", "user", 2, { limits: config(150, 250, 300) });
    w.reserve("r4", "primary", 110, "/v1/chat/completions", "model", []);
    w.settle("r4", 110);
    now += 604800001;
    assert.throws(
      () => w.reserve("monthly", "primary", 80, "/v1/chat/completions", "model", []),
      /USER_TOKEN_WINDOW_EXHAUSTED/
    );
    const balance = w.account("user")!.balance;
    const reset = q.changeUserLimits("reset", "user", 3, { reset: ["5h", "7d", "30d"] });
    assert.equal(
      reset.windows.every((r: { used: string }) => r.used === "0"),
      true
    );
    assert.deepEqual(q.changeUserLimits("reset", "user", 3, { reset: ["5h", "7d", "30d"] }), reset);
    assert.equal(w.account("user")!.balance, balance);
    assert.equal(q.poolStatus("bpbatam").issued, "1000000000");
    assert.equal(w.journalBalance(), 0);
  } finally {
    Date.now = original;
  }
});

test("an existing principal cannot bypass default windows after upgrade or lose an operator override", () => {
  w.createAccount("legacy-user", "dept", "user");
  w.allocate("legacy-fund", "dept", "legacy-user", 2000000, "owner");
  w.bindPrincipal("legacy-subject", "issuer", "legacy-user", "legacy-key");
  const db = core.getDbInstance();
  db.prepare("DELETE FROM bp_user_windows WHERE account_id=?").run("legacy-user");
  db.prepare("DELETE FROM bp_user_quota_profiles WHERE account_id=?").run("legacy-user");
  w.bindPrincipal("legacy-subject", "issuer", "legacy-user", "legacy-key");
  assert.throws(
    () =>
      w.reserve("legacy-over-limit", "legacy-key", 1000001, "/v1/chat/completions", "model", []),
    /USER_TOKEN_WINDOW_EXHAUSTED/
  );
  q.changeUserLimits("legacy-override", "legacy-user", 0, {
    limits: [{ window: "5h", tokens: 1500000 }],
  });
  w.bindPrincipal("legacy-subject", "issuer", "legacy-user", "legacy-key");
  assert.equal(q.userLimits("legacy-user").windows[0].limit, "1500000");
});
