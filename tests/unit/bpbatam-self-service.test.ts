import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bp-self-"));
process.env.API_KEY_SECRET = "self-service-test-only-secret";
process.env.DATA_DIR = directory;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const core = await import("../../src/lib/db/core.ts");
const wallet = await import("../../src/lib/db/bpbatam.ts");
const pool = await import("../../src/lib/db/bpbatamQuotas.ts");
const self = await import("../../src/lib/db/bpbatamSelfService.ts");
const keys = await import("../../src/lib/db/apiKeys.ts");
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(directory, { recursive: true, force: true });
});
test("custom total and additive pool commands preserve issuance, replay safety and concurrency", () => {
  assert.equal(pool.configurePool("opening", "set-total", 500000, 0, "owner").issued, "500000");
  const added = pool.configurePool("add", "add", 250000, 500000, "owner");
  assert.equal(added.issued, "750000");
  assert.deepEqual(pool.configurePool("add", "add", 250000, 500000, "owner"), added);
  assert.throws(
    () => pool.configurePool("add", "add", 250001, 500000, "owner"),
    /IDEMPOTENCY_CONFLICT/
  );
  assert.throws(
    () => pool.configurePool("stale", "add", 1, 500000, "owner"),
    /POOL_REVISION_CONFLICT/
  );
  assert.throws(
    () => pool.configurePool("decrease", "set-total", 1, 750000, "owner"),
    /POOL_BELOW_ALREADY_ISSUED/
  );
  assert.equal(pool.poolStatus("bpbatam").issued, "750000");
  assert.equal(wallet.journalBalance(), 0);
});
test("self-service summaries and keys are owner-scoped and child usage consumes the same wallet/windows", async () => {
  wallet.createAccount("a", "bpbatam", "user");
  wallet.createAccount("b", "bpbatam", "user");
  wallet.allocate("fund-a", "bpbatam", "a", 100000, "owner");
  wallet.allocate("fund-b", "bpbatam", "b", 100000, "owner");
  wallet.bindPrincipal("subject-a", "issuer", "a", "primary-a");
  wallet.bindPrincipal("subject-b", "issuer", "b", "primary-b");
  wallet.setOffers("subject-a", [{ id: "combo-a", kind: "combo", capabilities: ["chat"] }]);
  const key = await keys.createApiKey("External app", "self-test-machine", [], {
    modelAccessMode: "restricted",
    allowedCombos: ["combo-a"],
    allowedModels: [],
  });
  wallet.bindSubjectKey("subject-a", key.id, "self-command", "External app");
  self.followParentKey(key.id);
  wallet.reserve("request-a", key.id, 100, "/v1/chat/completions", "combo-a", []);
  wallet.settle("request-a", 70);
  const account = self.selfAccount("subject-a");
  assert.equal(account.wallet.balance, "99930");
  assert.equal(
    account.limits.windows.every((w) => w.used === "70"),
    true
  );
  assert.equal((account.totals as { requests: number }).requests, 1);
  assert.equal((self.selfAccount("subject-b").totals as { requests: number }).requests, 0);
  assert.equal(self.selfKeys("subject-b").length, 0);
  assert.equal(JSON.stringify(self.selfKeys("subject-a")).includes(key.key), false);
  assert.equal(self.followingKeys("subject-a").length, 1);
  assert.throws(() => self.ownedSelfKey("subject-b", key.id), /SUBJECT_KEY_NOT_FOUND/);
  assert.throws(
    () => self.renameSelfKey("subject-b", key.id, "Forbidden"),
    /SUBJECT_KEY_NOT_FOUND/
  );
  self.renameSelfKey("subject-a", key.id, "Renamed external app");
  assert.equal((await keys.getApiKeyById(key.id))?.name, "Renamed external app");
  assert.equal((self.selfKeys("subject-a")[0] as { name: string }).name, "Renamed external app");
  assert.throws(() => wallet.revokeSubjectKey("subject-b", key.id), /SUBJECT_KEY_NOT_FOUND/);
  wallet.revokeSubjectKey("subject-a", key.id);
  assert.equal(self.selfKeys("subject-a").length, 0);
  assert.throws(
    () => wallet.reserve("revoked", key.id, 1, "/v1/chat/completions", "combo-a", []),
    /PRINCIPAL_DISABLED/
  );
});
