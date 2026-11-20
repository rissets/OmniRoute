import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-auto-reconcile-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");
const wallet = await import("../../src/lib/db/bpbatam.ts");
const reconciler = await import("../../src/lib/bpbatam/autoReconcile.ts");

const prevDigiUrl = process.env.DIGI_ROUTE_URL;
const prevDigiKey = process.env.DIGI_ROUTE_API_KEY;

let seq = 0;
function createUncertainUserReceipt(balanceMicro = 10_000_000, reservedMicro = 500_000) {
  const id = `rec-user-${++seq}`;
  const receiptId = `key-${id}:rcpt-${seq}`;
  wallet.createAccount(id, null, "user");
  wallet.allocate(`grant-${id}`, null, id, balanceMicro, "issuer");
  wallet.bindPrincipal(id, "issuer", id, `key-${id}`);
  wallet.reserve(
    receiptId,
    `key-${id}`,
    reservedMicro,
    "/v1/chat/completions",
    "gpt-6.1-terra",
    []
  );
  wallet.settle(receiptId, null, { reason: "stream_interrupted" });
  return { id, receiptId, balanceMicro, reservedMicro };
}

test.after(() => {
  reconciler.stopAutoReconcileWorker();
  if (prevDigiUrl === undefined) delete process.env.DIGI_ROUTE_URL;
  else process.env.DIGI_ROUTE_URL = prevDigiUrl;
  if (prevDigiKey === undefined) delete process.env.DIGI_ROUTE_API_KEY;
  else process.env.DIGI_ROUTE_API_KEY = prevDigiKey;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("auto-reconcile handles settle, release (actual=0 and 404), and keep_uncertain outcomes", async () => {
  const uSettle = createUncertainUserReceipt(10_000_000, 500_000);
  const uReleaseZero = createUncertainUserReceipt(10_000_000, 400_000);
  const uRelease404 = createUncertainUserReceipt(10_000_000, 300_000);
  const uKeepUncertain = createUncertainUserReceipt(10_000_000, 200_000);
  const uKeep503 = createUncertainUserReceipt(10_000_000, 100_000);

  let seenAuth = "";
  const server = http.createServer((req, res) => {
    seenAuth = String(req.headers.authorization ?? "");
    const prefix = "/api/v1/digi-credit/receipts/";
    if (!req.url?.startsWith(prefix)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const id = decodeURIComponent(req.url.slice(prefix.length));
    if (id === uSettle.receiptId) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "dgr-1",
          external_receipt_id: id,
          state: "settled",
          actual_micro: 125_000,
          usage: { input: 500, output: 200 },
        })
      );
      return;
    }
    if (id === uReleaseZero.receiptId) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "dgr-2",
          external_receipt_id: id,
          state: "settled",
          actual_micro: 0,
          usage: {},
        })
      );
      return;
    }
    if (id === uRelease404.receiptId) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "RECEIPT_NOT_FOUND" }));
      return;
    }
    if (id === uKeepUncertain.receiptId) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "dgr-4",
          external_receipt_id: id,
          state: "uncertain",
          actual_micro: null,
        })
      );
      return;
    }
    if (id === uKeep503.receiptId) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "UPSTREAM_BUSY" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  process.env.DIGI_ROUTE_URL = `http://127.0.0.1:${addr.port}`;
  process.env.DIGI_ROUTE_API_KEY = "dgr-reconcile-key";

  try {
    // Respects minAgeMs when freshly created
    const skippedPass = await reconciler.runAutoReconcilePass({ minAgeMs: 60_000 });
    assert.equal(skippedPass.settled, 0);
    assert.equal(skippedPass.released, 0);
    assert.equal(wallet.admission(uSettle.receiptId)?.state, "uncertain");

    // With minAgeMs: 0, processes all uncertain receipts
    const summary = await reconciler.runAutoReconcilePass({ minAgeMs: 0 });
    assert.equal(seenAuth, "Bearer dgr-reconcile-key");
    assert.equal(summary.settled, 1);
    assert.equal(summary.released, 2);
    assert.equal(summary.keptUncertain, 2);

    // 1. Settled with actual_micro = 125_000
    assert.equal(wallet.admission(uSettle.receiptId)?.state, "settled");
    assert.equal(wallet.admission(uSettle.receiptId)?.actual, 125_000);
    assert.equal(wallet.account(uSettle.id)?.balance, 10_000_000 - 125_000);
    assert.equal(wallet.account(uSettle.id)?.reserved, 0);

    // 2. Released (actual_micro = 0)
    assert.equal(wallet.admission(uReleaseZero.receiptId)?.state, "settled");
    assert.equal(wallet.admission(uReleaseZero.receiptId)?.actual, 0);
    assert.equal(wallet.account(uReleaseZero.id)?.balance, 10_000_000);
    assert.equal(wallet.account(uReleaseZero.id)?.reserved, 0);

    // 3. Released (404 RECEIPT_NOT_FOUND -> never reached Digi Route)
    assert.equal(wallet.admission(uRelease404.receiptId)?.state, "settled");
    assert.equal(wallet.admission(uRelease404.receiptId)?.actual, 0);
    assert.equal(wallet.account(uRelease404.id)?.balance, 10_000_000);
    assert.equal(wallet.account(uRelease404.id)?.reserved, 0);

    // 4. Kept uncertain (Digi Route still uncertain)
    const kept1 = wallet.admission(uKeepUncertain.receiptId)!;
    assert.equal(kept1.state, "uncertain");
    assert.equal(kept1.reconcile_attempts, 1);
    assert.equal(wallet.account(uKeepUncertain.id)?.reserved, 200_000);

    // 5. Kept uncertain (Digi Route returned 503)
    const kept2 = wallet.admission(uKeep503.receiptId)!;
    assert.equal(kept2.state, "uncertain");
    assert.equal(kept2.reconcile_attempts, 1);
    assert.equal(wallet.account(uKeep503.id)?.reserved, 100_000);

    assert.equal(wallet.journalBalance(), 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
