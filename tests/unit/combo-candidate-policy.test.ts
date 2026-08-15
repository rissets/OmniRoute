import assert from "node:assert/strict";
import test from "node:test";
import { shouldEnforceCandidateModelAllowlist } from "../../src/sse/handlers/comboCandidatePolicy";

test("explicit combo grant remains dispatchable beside exact media grant", () => {
  const policy = { allowedModels: ["openai/gpt-image-1-mini"], allowedCombos: ["bp/gpt-5.6-sol-medium"] };
  assert.equal(shouldEnforceCandidateModelAllowlist(policy, "bp/gpt-5.6-sol-medium"), false);
  assert.equal(shouldEnforceCandidateModelAllowlist(policy, "auto/best-chat"), true);
});
