import test from "node:test";
import assert from "node:assert/strict";

const policy = await import("../../src/shared/constants/bpRouteProviderPolicy.ts");
const providerPageUtils =
  await import("../../src/app/(dashboard)/dashboard/providers/providerPageUtils.ts");
const onboardingCatalog =
  await import("../../src/app/(dashboard)/dashboard/providers/components/onboarding/providerOnboardingCatalog.ts");

test("BP Route provider hard-lock is enabled by default when env var is unset", () => {
  const prev = process.env.BP_ROUTE_PROVIDER_HARD_LOCK;
  delete process.env.BP_ROUTE_PROVIDER_HARD_LOCK;
  try {
    assert.equal(policy.isBpRouteProviderHardLockEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.BP_ROUTE_PROVIDER_HARD_LOCK;
    else process.env.BP_ROUTE_PROVIDER_HARD_LOCK = prev;
  }
});

test("BP Route provider hard-lock respects explicit false/0/off opt-out and true opt-in", () => {
  const prev = process.env.BP_ROUTE_PROVIDER_HARD_LOCK;
  try {
    for (const disabled of ["false", "0", "off", "no", "FALSE"]) {
      process.env.BP_ROUTE_PROVIDER_HARD_LOCK = disabled;
      assert.equal(policy.isBpRouteProviderHardLockEnabled(), false, disabled);
    }
    for (const enabled of ["true", "1", "yes", "on", ""]) {
      process.env.BP_ROUTE_PROVIDER_HARD_LOCK = enabled;
      assert.equal(policy.isBpRouteProviderHardLockEnabled(), true, enabled);
    }
  } finally {
    if (prev === undefined) delete process.env.BP_ROUTE_PROVIDER_HARD_LOCK;
    else process.env.BP_ROUTE_PROVIDER_HARD_LOCK = prev;
  }
});

test("BP Route policy allows only openai-compatible, non-CC anthropic-compatible, and ce_ custom endpoints", () => {
  assert.equal(policy.isAllowedBpRouteProviderId("openai-compatible-chat-digi"), true);
  assert.equal(policy.isAllowedBpRouteProviderId("anthropic-compatible-digi"), true);
  assert.equal(policy.isAllowedBpRouteProviderId("ce_1234567890abcdef"), true);
  assert.equal(
    policy.isAllowedBpRouteProviderId("custom-node", {
      id: "custom-node",
      type: "openai-compatible",
    }),
    true
  );
  assert.equal(
    policy.isAllowedBpRouteProviderId("custom-anthropic", {
      id: "custom-anthropic",
      type: "anthropic-compatible",
    }),
    true
  );

  // Built-in, alias, and Claude Code compatible providers are disallowed
  for (const disallowed of [
    "openai",
    "anthropic",
    "claude",
    "codex",
    "cx",
    "cc",
    "deepseek",
    "ds",
    "gemini",
    "openrouter",
    "qoder",
    "synthetic",
    "grok-web",
    "ollama-local",
    "cliproxyapi",
    "anthropic-compatible-cc-local",
    "",
  ]) {
    assert.equal(policy.isAllowedBpRouteProviderId(disallowed), false, disallowed);
  }
});

test("BP Route node type policy permits only openai-compatible and non-CC anthropic-compatible nodes", () => {
  assert.equal(policy.isAllowedBpRouteNodeType("openai-compatible"), true);
  assert.equal(policy.isAllowedBpRouteNodeType("anthropic-compatible"), true);
  assert.equal(policy.isAllowedBpRouteNodeType("anthropic-compatible", undefined), true);
  assert.equal(policy.isAllowedBpRouteNodeType("anthropic-compatible", "cc"), false);
  assert.equal(
    policy.isAllowedBpRouteNodeType("openai-compatible", undefined, "vibeproxy-openai"),
    false
  );
  assert.equal(policy.isAllowedBpRouteNodeType("oauth"), false);
  assert.equal(policy.isAllowedBpRouteNodeType(""), false);
});

test("shouldShowProviderSection hides all built-in categories when hard-lock is active", () => {
  for (const cat of [
    "oauth",
    "ide",
    "free",
    "no-auth",
    "upstream-proxy",
    "apikey",
    "webcookie",
    "search",
    "webfetch",
    "audio",
    "local",
    "cloudagent",
  ]) {
    assert.equal(
      providerPageUtils.shouldShowProviderSection(cat, null, false, true),
      false,
      `${cat} must stay hidden under hard-lock`
    );
    assert.equal(
      providerPageUtils.shouldShowProviderSection(cat, cat, false, true),
      false,
      `${cat} must stay hidden even when requested via URL category under hard-lock`
    );
  }
  assert.equal(providerPageUtils.shouldShowProviderSection("compatible", null, false, true), true);
  assert.equal(
    providerPageUtils.shouldShowProviderSection("compatible", "oauth", true, true),
    true
  );
});

test("buildCompatibleProviderGroups omits CC-compatible nodes when hard-lock is enabled", () => {
  const labels = {
    openaiCompatibleName: "OpenAI Compatible",
    anthropicCompatibleName: "Anthropic Compatible",
    claudeCodeCompatibleName: "Claude Code Compatible",
  };
  const groups = providerPageUtils.buildCompatibleProviderGroups(
    [
      { id: "openai-compatible-chat-digi", name: "Digi OAI", type: "openai-compatible" },
      { id: "anthropic-compatible-digi", name: "Digi Ant", type: "anthropic-compatible" },
      { id: "anthropic-compatible-cc-hidden", name: "Hidden CC", type: "anthropic-compatible" },
      { id: "ce_abc123", name: "Control Panel Custom", type: "openai-compatible" },
    ],
    labels,
    { hardLock: true }
  );

  assert.deepEqual(
    groups.openai.map((n) => n.id),
    ["openai-compatible-chat-digi", "ce_abc123"]
  );
  assert.deepEqual(
    groups.anthropic.map((n) => n.id),
    ["anthropic-compatible-digi"]
  );
  assert.deepEqual(groups.claudeCode, []);
});

test("loadProviderPageData propagates bpRouteProviderHardLock and forces CC off", async () => {
  const mockFetch = async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u === "/api/provider-nodes") {
      return Response.json({
        nodes: [],
        bpRouteProviderHardLock: true,
        ccCompatibleProviderEnabled: true,
      });
    }
    return Response.json({});
  };

  const data = await providerPageUtils.loadProviderPageData(mockFetch as typeof fetch, 2000);
  assert.equal(data.bpRouteProviderHardLock, true);
  assert.equal(data.ccCompatibleProviderEnabled, false);
});

test("providerOnboardingCatalog returns empty built-in lists when hardLock is true", () => {
  assert.deepEqual(onboardingCatalog.getWizardApiKeyProviderOptions({ hardLock: true }), []);
  assert.deepEqual(onboardingCatalog.getWizardOAuthProviderOptions({ hardLock: true }), []);
});
