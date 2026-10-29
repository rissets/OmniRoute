import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bp-page-"));
process.env.DATA_DIR = directory;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const core = await import("../../src/lib/db/core.ts");
const wallet = await import("../../src/lib/db/bpbatam.ts");
const page = {
  page: 1,
  page_size: 10,
  search: "",
  sort_by: "id",
  sort_order: "asc",
  filter_by: "",
  filter_value: "",
};
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(directory, { recursive: true, force: true });
});
test("receipt pages count descendants and never truncate at the old 200-row ceiling", () => {
  wallet.createAccount("root", null, "platform");
  wallet.createAccount("department", "root", "department");
  wallet.createAccount("user", "department", "user");
  wallet.createAccount("outsider", null, "platform");
  wallet.allocate("grant", null, "user", 10000, "admin");
  wallet.bindPrincipal("subject", "issuer", "user", "key");
  for (let i = 0; i < 235; i++) {
    wallet.reserve("receipt-" + String(i).padStart(3, "0"), "key", 1, "/chat", "model", []);
    wallet.settle("receipt-" + String(i).padStart(3, "0"), 1);
  }
  const first = wallet.receiptPage("department", page);
  const second = wallet.receiptPage("department", { ...page, page: 2 });
  assert.equal(first.total, 235);
  assert.equal(first.receipts.length, 10);
  assert.equal(second.receipts.length, 10);
  assert.equal(new Set([...first.receipts, ...second.receipts].map((r) => r.id)).size, 20);
  assert.equal(wallet.receiptPage("outsider", page).total, 0);
  const last = wallet.receiptPage("root", { ...page, page: 24 });
  assert.equal(last.receipts.length, 5);
  assert.ok("usage" in first.receipts[0]);
  assert.ok(!("usage_json" in first.receipts[0]));
  assert.equal(wallet.receiptPage("root", { ...page, search: "%" }).total, 0);
});
test("topup count, search, sort and account scope apply before pagination", () => {
  for (let i = 0; i < 27; i++)
    wallet.requestTopup(
      "topup-" + i,
      i % 2 ? "user" : "outsider",
      i + 1,
      "actor",
      "Unit request " + i
    );
  const result = wallet.topupPage({ ...page, sort_by: "amount", sort_order: "desc" }, ["user"]);
  assert.equal(result.total, 13);
  assert.equal(result.requests.length, 10);
  assert.equal((result.requests[0] as { amount: number }).amount, 26);
  assert.equal(wallet.topupPage({ ...page, page: 2 }, ["user"]).requests.length, 3);
  assert.equal(wallet.topupPage(page, []).total, 0);
  assert.equal(wallet.topupPage({ ...page, search: "%" }).total, 0);
});
