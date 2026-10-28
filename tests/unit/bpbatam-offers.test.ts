import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bp-offers-"));
process.env.DATA_DIR = directory;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.API_KEY_SECRET = "synthetic-offers-unit-test-secret";

const core = await import("../../src/lib/db/core.ts");
const wallet = await import("../../src/lib/db/bpbatam.ts");
const keys = await import("../../src/lib/db/apiKeys.ts");
const providers = await import("../../src/lib/db/providers/nodes.ts");
const models = await import("../../src/lib/db/models.ts");
const combos = await import("../../src/lib/db/combos.ts");
const offers = await import("../../src/lib/bpbatam/offers.ts");

const providerId = "offers-test-provider";
const modelId = "offers-test/chat";
const subject = "offers-test-user";

await providers.createProviderNode({
  id: providerId,
  prefix: "offers-test",
  type: "openai-compatible",
  name: "Synthetic offer tests",
});
await models.addCustomModel(providerId, "chat");
const apiKey = await keys.createApiKey(subject, "unit-test");
wallet.createAccount("root", null, "platform");
wallet.createAccount(subject, "root", "user");
wallet.bindPrincipal(subject, "issuer", subject, apiKey.id);

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("unrelated alias changes do not invalidate an unchanged model offer", async () => {
  const offer = (await offers.publishedOffers()).find((item) => item.id === modelId);
  assert.ok(offer);
  wallet.setOffers(subject, [offer]);

  await models.setModelAlias("unrelated-test-alias", "other-provider/other-model");

  const current = (await offers.publishedOffers()).find((item) => item.id === modelId);
  assert.equal(current?.version, offer.version);
  assert.equal(await offers.managedPolicy(apiKey.id, "/v1/chat/completions", modelId), null);
});

test("changing a combo's assigned target remains denied", async () => {
  await models.addCustomModel(providerId, "other");
  const combo = await combos.createCombo({
    name: "offers-test-combo",
    models: [modelId],
    strategy: "priority",
  });
  const offer = (await offers.publishedOffers()).find((item) => item.id === combo.name);
  assert.ok(offer);
  wallet.setOffers(subject, [offer]);

  await models.setModelAlias("unrelated-combo-alias", "other-provider/other-model");
  const afterAliasChange = (await offers.publishedOffers()).find((item) => item.id === combo.name);
  assert.equal(afterAliasChange?.version, offer.version);
  assert.equal(
    await offers.managedPolicy(apiKey.id, "/v1/chat/completions", String(combo.name)),
    null
  );

  await combos.updateCombo(String(combo.id), { models: ["offers-test/other"] });

  const response = await offers.managedPolicy(
    apiKey.id,
    "/v1/chat/completions",
    String(combo.name)
  );
  assert.equal(response?.status, 409);
  assert.match(await response!.text(), /OFFER_VERSION_CHANGED/);
});

test("a model removed from the live catalog remains denied by the stored policy", async () => {
  const offer = (await offers.publishedOffers()).find((item) => item.id === modelId);
  assert.ok(offer);
  wallet.setOffers(subject, [offer]);
  assert.equal(await models.removeCustomModel(providerId, "chat"), true);

  const response = await offers.managedPolicy(apiKey.id, "/v1/chat/completions", modelId);
  assert.equal(response?.status, 409);
  assert.match(await response!.text(), /OFFER_VERSION_CHANGED/);
});
