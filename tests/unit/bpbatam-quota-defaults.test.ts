import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bp-defaults-"));
process.env.DATA_DIR = directory;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const pair = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(pair.publicKey)), kid: "test-defaults-key", alg: "RS256" };
const oidcServer = http.createServer((_req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ keys: [jwk] }));
});

const { promise: serverListening, resolve: resolveListening } = Promise.withResolvers<void>();
oidcServer.listen(0, "127.0.0.1", () => resolveListening());
await serverListening;

const oidcAddress = oidcServer.address() as AddressInfo;
const oidcIssuer = `http://127.0.0.1:${oidcAddress.port}`;
process.env.BPBATAM_OIDC_ISSUER = oidcIssuer;
process.env.BPBATAM_SERVICE_AUDIENCE = "defaults-tests";

const core = await import("../../src/lib/db/core.ts");
const w = await import("../../src/lib/db/bpbatam.ts");
const q = await import("../../src/lib/db/bpbatamQuotas.ts");
const route = await import("../../src/app/api/bpbatam/[action]/route.ts");

test.after(() => {
  q.stopQuotaDefaultsScheduler();
  core.resetDbInstance();
  oidcServer.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("quota defaults initialize to 1m/10m/30m and are applied only on new profile creation", () => {
  const initial = q.quotaDefaults();
  assert.equal(initial.revision, 0);
  assert.deepEqual(initial.windows, [
    { window: "5h", tokens: 1000000 },
    { window: "7d", tokens: 10000000 },
    { window: "30d", tokens: 30000000 },
  ]);
  assert.equal(initial.scheduled_next_month, null);

  // Provision an initial user A (e.g. via SSO / bindPrincipal)
  w.createAccount("user-a", null, "user");
  w.allocate("fund-a", null, "user-a", 5000000, "owner");
  w.bindPrincipal("sub-a", "issuer", "user-a", "key-a");

  const limitsA = q.userLimits("user-a");
  assert.equal(limitsA.windows.find((w) => w.window === "5h")?.limit, "1000000");
  assert.equal(limitsA.windows.find((w) => w.window === "7d")?.limit, "10000000");
  assert.equal(limitsA.windows.find((w) => w.window === "30d")?.limit, "30000000");

  // Operator updates defaults to 2m / 20m / 50m without schedule
  const updated = q.changeQuotaDefaults(
    "cmd-update-1",
    [
      { window: "5h", tokens: 2000000 },
      { window: "7d", tokens: 20000000 },
      { window: "30d", tokens: 50000000 },
    ],
    { expectedRevision: 0 }
  );

  assert.equal(updated.revision, 1);
  assert.deepEqual(updated.windows, [
    { window: "5h", tokens: 2000000 },
    { window: "7d", tokens: 20000000 },
    { window: "30d", tokens: 50000000 },
  ]);

  // Existing user A MUST PRESERVE prior limits
  const limitsAAfter = q.userLimits("user-a");
  assert.equal(limitsAAfter.windows.find((w) => w.window === "5h")?.limit, "1000000");

  // Newly provisioned user B inherits the updated defaults
  w.createAccount("user-b", null, "user");
  w.allocate("fund-b", null, "user-b", 5000000, "owner");
  w.bindPrincipal("sub-b", "issuer", "user-b", "key-b");

  const limitsB = q.userLimits("user-b");
  assert.equal(limitsB.windows.find((w) => w.window === "5h")?.limit, "2000000");
  assert.equal(limitsB.windows.find((w) => w.window === "7d")?.limit, "20000000");
  assert.equal(limitsB.windows.find((w) => w.window === "30d")?.limit, "50000000");
});

test("optimistic revision check, idempotency, and input validation", () => {
  // Revision conflict
  assert.throws(
    () =>
      q.changeQuotaDefaults(
        "cmd-conflict",
        [
          { window: "5h", tokens: 500000 },
          { window: "7d", tokens: 5000000 },
          { window: "30d", tokens: 15000000 },
        ],
        { expectedRevision: 999 }
      ),
    /REVISION_CONFLICT/
  );

  // Invalid windows (missing a window or duplicate)
  assert.throws(
    () =>
      q.changeQuotaDefaults("cmd-invalid-1", [
        { window: "5h", tokens: 500000 },
        { window: "5h", tokens: 500000 },
        { window: "30d", tokens: 15000000 },
      ]),
    /INVALID_USER_WINDOWS/
  );

  // Idempotent retry with same command_id and payload returns identical result
  const current = q.quotaDefaults();
  const res1 = q.changeQuotaDefaults(
    "cmd-idemp",
    [
      { window: "5h", tokens: 3000000 },
      { window: "7d", tokens: 30000000 },
      { window: "30d", tokens: 90000000 },
    ],
    { expectedRevision: current.revision }
  );
  const res2 = q.changeQuotaDefaults("cmd-idemp", [
    { window: "5h", tokens: 3000000 },
    { window: "7d", tokens: 30000000 },
    { window: "30d", tokens: 90000000 },
  ]);
  assert.deepEqual(res1, res2);

  // Idempotency conflict when same command_id has different payload
  assert.throws(
    () =>
      q.changeQuotaDefaults("cmd-idemp", [
        { window: "5h", tokens: 4000000 },
        { window: "7d", tokens: 40000000 },
        { window: "30d", tokens: 90000000 },
      ]),
    /IDEMPOTENCY_CONFLICT/
  );
});

test("scheduled application to existing users next month Asia/Jakarta preserves usage and anchors", () => {
  // user-a currently has 1m limit and performs some usage
  w.reserve("res-a1", "key-a", 150, "/v1/chat/completions", "model", []);
  w.settle("res-a1", 120);
  const beforeUsage = q.userLimits("user-a").windows[0].used;
  assert.equal(beforeUsage, "120");

  const nowMs = Date.parse("2026-11-15T10:00:00Z");
  const nextMonthExpected = q.getNextMonthAsiaJakarta(nowMs);
  assert.equal(nextMonthExpected.iso, "2026-12-01T00:00:00+07:00");

  // Schedule new defaults with applyNextMonth = true
  const currentRev = q.quotaDefaults().revision;
  const scheduled = q.changeQuotaDefaults(
    "cmd-sched-1",
    [
      { window: "5h", tokens: 5000000 },
      { window: "7d", tokens: 50000000 },
      { window: "30d", tokens: 150000000 },
    ],
    { expectedRevision: currentRev, applyNextMonth: true }
  );

  assert.ok(scheduled.scheduled_next_month);
  assert.equal(scheduled.scheduled_next_month.effective_at, "2026-12-01T00:00:00+07:00");
  assert.ok(scheduled.scheduled_next_month.eligible_accounts_count >= 2); // user-a, user-b

  // Querying defaults also shows pending schedule
  const queried = q.quotaDefaults();
  assert.deepEqual(queried.scheduled_next_month, scheduled.scheduled_next_month);

  // User C onboarded AFTER schedule was created inherits current defaults (5m/50m/150m)
  w.createAccount("user-c", null, "user");
  w.allocate("fund-c", null, "user-c", 10000000, "owner");
  w.bindPrincipal("sub-c", "issuer", "user-c", "key-c");
  assert.equal(q.userLimits("user-c").windows[0].limit, "5000000");

  // Before effective date, existing user-a still has old limit
  const earlyRun = q.applyPendingQuotaDefaultsNextMonth(nowMs + 86400000); // 1 day later
  assert.equal(earlyRun.appliedSchedules, 0);
  assert.equal(q.userLimits("user-a").windows[0].limit, "1000000");

  // Simulate active reservation on user-a right before next month boundary
  w.reserve("res-a2", "key-a", 200, "/v1/chat/completions", "model", []);

  // When effective time arrives (2026-12-01 00:00:00 WIB)
  const effectiveMs = nextMonthExpected.ms;
  const execution = q.applyPendingQuotaDefaultsNextMonth(effectiveMs);
  assert.equal(execution.appliedSchedules, 1);
  assert.ok(execution.affectedAccounts >= 2);

  // user-a now has updated limit 5m, but usage and reserved tokens are PRESERVED (no reset!)
  const limitsAPost = q.userLimits("user-a");
  assert.equal(limitsAPost.windows[0].limit, "5000000");
  assert.equal(limitsAPost.windows[0].used, "120");
  assert.equal(limitsAPost.windows[0].reserved, "200");

  // Idempotent: running again does nothing
  const rerun = q.applyPendingQuotaDefaultsNextMonth(effectiveMs + 1000);
  assert.equal(rerun.appliedSchedules, 0);

  // Schedule is now cleared from pending
  assert.equal(q.quotaDefaults().scheduled_next_month, null);
});

test("API route GET /api/bpbatam/quota-defaults and POST /api/bpbatam/commands", async () => {
  // Test route rejection without auth
  const unauthGet = await route.GET(new Request("http://localhost/api/bpbatam/quota-defaults"));
  assert.equal(unauthGet.status, 401);

  const makeToken = async (roles = ["bp:read", "bp:write", "bp:root"]) =>
    new SignJWT({ azp: "control-panel", realm_access: { roles } })
      .setProtectedHeader({ alg: "RS256", kid: "test-defaults-key" })
      .setIssuer(oidcIssuer)
      .setAudience("defaults-tests")
      .setSubject("admin-subject")
      .setIssuedAt()
      .setExpirationTime("2m")
      .sign(pair.privateKey);

  const token = await makeToken();

  // Authorized GET
  const resGet = await route.GET(
    new Request("http://localhost/api/bpbatam/quota-defaults", {
      headers: { Authorization: "Bearer " + token },
    })
  );
  assert.equal(resGet.status, 200);
  const bodyGet = (await resGet.json()) as {
    revision: number;
    windows: { window: string; tokens: number }[];
  };
  assert.ok(Array.isArray(bodyGet.windows));
  assert.equal(typeof bodyGet.revision, "number");

  // Authorized POST
  const resPost = await route.POST(
    new Request("http://localhost/api/bpbatam/commands", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "quota-defaults",
        command_id: "cmd-api-test-1",
        expected_revision: bodyGet.revision,
        limits: [
          { window: "5h", tokens: 8000000 },
          { window: "7d", tokens: 80000000 },
          { window: "30d", tokens: 240000000 },
        ],
      }),
    })
  );
  assert.equal(resPost.status, 200);
  const bodyPost = (await resPost.json()) as {
    revision: number;
    windows: { window: string; tokens: number }[];
  };
  assert.equal(bodyPost.revision, bodyGet.revision + 1);
  assert.equal(bodyPost.windows.find((w) => w.window === "5h")?.tokens, 8000000);
});
