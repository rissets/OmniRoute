import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bp-pool-lock-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.JWT_SECRET = "test-jwt-secret-bp-pool-lock";
process.env.INITIAL_PASSWORD = "admin-secret";

const core = await import("../../src/lib/db/core.ts");
const poolRoute = await import("../../src/app/api/bpbatam-pool/route.ts");
const quotas = await import("../../src/lib/db/bpbatamQuotas.ts");

const prevDigiUrl = process.env.DIGI_ROUTE_URL;
const prevDigiKey = process.env.DIGI_ROUTE_API_KEY;
const prevTopupUrl = process.env.DIGI_ROUTE_TOPUP_URL;

test.after(() => {
  if (prevDigiUrl === undefined) delete process.env.DIGI_ROUTE_URL;
  else process.env.DIGI_ROUTE_URL = prevDigiUrl;
  if (prevDigiKey === undefined) delete process.env.DIGI_ROUTE_API_KEY;
  else process.env.DIGI_ROUTE_API_KEY = prevDigiKey;
  if (prevTopupUrl === undefined) delete process.env.DIGI_ROUTE_TOPUP_URL;
  else process.env.DIGI_ROUTE_TOPUP_URL = prevTopupUrl;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("POST /api/bpbatam-pool rejects manual set-total and add minting with 403 MANUAL_POOL_MINTING_DISABLED", async () => {
  for (const mode of ["set-total", "add"] as const) {
    const req = await makeManagementSessionRequest("http://localhost/api/bpbatam-pool", {
      method: "POST",
      headers: { origin: "http://localhost" },
      body: {
        command_id: "11111111-1111-4111-8111-111111111111",
        mode,
        tokens: 1_000_000,
        expected_issued: 0,
      },
    });
    const res = await poolRoute.POST(req);
    assert.equal(res.status, 403, `${mode} must be rejected with 403`);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, "MANUAL_POOL_MINTING_DISABLED");
  }
  assert.equal(quotas.poolStatus("bpbatam").issued, "0");
});

test("POST /api/bpbatam-pool accepts same-origin Host header when standalone server binds 0.0.0.0", async () => {
  const req = await makeManagementSessionRequest("http://0.0.0.0:20128/api/bpbatam-pool", {
    method: "POST",
    headers: {
      host: "127.0.0.1:20128",
      origin: "http://127.0.0.1:20128",
    },
    body: { mode: "add", tokens: 1_000_000 },
  });
  const res = await poolRoute.POST(req);
  assert.equal(res.status, 403);
  const body = (await res.json()) as { code: string };
  assert.equal(body.code, "MANUAL_POOL_MINTING_DISABLED");
});

test("GET /api/bpbatam-pool returns micro_credits status, token equivalent, topup_url, and digi_sync", async () => {
  process.env.DIGI_ROUTE_TOPUP_URL = "https://billing.bpbatam.test/topup";
  const req = await makeManagementSessionRequest("http://localhost/api/bpbatam-pool");
  const res = await poolRoute.GET(req);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.manual_minting_disabled, true);
  assert.equal(body.unit, "micro_credits");
  assert.equal(body.topup_url, "https://billing.bpbatam.test/topup?tenant_id=bpbatam");
  assert.ok(typeof body.remaining_credits === "string");
  assert.ok(typeof body.estimated_tokens === "number");
  assert.ok(body.digi_sync && typeof body.digi_sync === "object");
});

test("POST /api/bpbatam-pool pull-sync pulls balance from Digi Route and mints only positive deficit", async () => {
  let digiBalanceMicro = 200_000_000;
  let lastAuthHeader = "";
  const server = http.createServer((req, res) => {
    lastAuthHeader = String(req.headers.authorization ?? "");
    if (req.url?.startsWith("/api/v1/digi-credit/balance")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          tenant_id: "bpbatam",
          account_id: "bproute-bpbatam",
          balance_micro: digiBalanceMicro,
          reserved_micro: 0,
          available_micro: digiBalanceMicro,
          balance_credits: "200.000000",
          reserved_credits: "0.000000",
          available_credits: "200.000000",
          estimated_tokens: 30_440_000,
          economic_snapshot: {
            base_credit_rupiah: 5000,
            usd_idr_rate: 18000,
            ref_tokens_per_credit: 160000,
            revision: 3,
          },
        })
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  process.env.DIGI_ROUTE_URL = `http://127.0.0.1:${addr.port}`;
  process.env.DIGI_ROUTE_API_KEY = "dgr-secret-key";

  try {
    const syncReq1 = await makeManagementSessionRequest("http://localhost/api/bpbatam-pool", {
      method: "POST",
      headers: { origin: "http://localhost" },
      body: { action: "pull-sync" },
    });
    const syncRes1 = await poolRoute.POST(syncReq1);
    assert.equal(syncRes1.status, 200);
    const body1 = (await syncRes1.json()) as Record<string, unknown>;
    assert.equal(lastAuthHeader, "Bearer dgr-secret-key");
    assert.equal(body1.synced, true);
    assert.equal(body1.delta_micro, 200_000_000);
    const pool1 = body1.pool as Record<string, unknown>;
    assert.equal(pool1.remaining, "200000000");
    assert.equal(pool1.remaining_credits, "200.000000");
    assert.equal(pool1.ref_tokens_per_credit, 160000);
    assert.equal(pool1.estimated_tokens, 32_000_000);

    // Repeating pull-sync with same Digi Route balance does not mint duplicate credits
    const syncReq2 = await makeManagementSessionRequest("http://localhost/api/bpbatam-pool", {
      method: "POST",
      headers: { origin: "http://localhost" },
      body: { action: "pull-sync" },
    });
    const syncRes2 = await poolRoute.POST(syncReq2);
    assert.equal(syncRes2.status, 200);
    const body2 = (await syncRes2.json()) as Record<string, unknown>;
    assert.equal(body2.delta_micro, 0);
    assert.equal((body2.pool as Record<string, unknown>).remaining, "200000000");

    // If Digi Route balance is lower (e.g., upstream consumed), BP Route does not mint
    digiBalanceMicro = 150_000_000;
    const syncReq3 = await makeManagementSessionRequest("http://localhost/api/bpbatam-pool", {
      method: "POST",
      headers: { origin: "http://localhost" },
      body: { action: "pull-sync" },
    });
    const syncRes3 = await poolRoute.POST(syncReq3);
    assert.equal(syncRes3.status, 200);
    const body3 = (await syncRes3.json()) as Record<string, unknown>;
    assert.equal(body3.delta_micro, 0);
    assert.equal((body3.pool as Record<string, unknown>).remaining, "200000000");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
