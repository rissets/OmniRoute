import test from "node:test";
import assert from "node:assert/strict";
import { computeBillableTokens } from "../../open-sse/handlers/chatCore/upstreamTimeouts.ts";

test("OpenAI reasoning is a subset of completion tokens", () => {
  assert.equal(
    computeBillableTokens({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      completion_tokens_details: { reasoning_tokens: 20 },
    }),
    150
  );
});
test("Anthropic cache parts are disjoint input; thinking is inside output", () => {
  assert.equal(
    computeBillableTokens({
      input_tokens: 60,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 10,
      output_tokens: 50,
    }),
    150
  );
});
test("Responses reasoning and cached input remain breakdowns", () => {
  assert.equal(
    computeBillableTokens({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 30 },
      output_tokens: 50,
      output_tokens_details: { reasoning_tokens: 20 },
    }),
    150
  );
});

const { geminiToOpenAIResponse } =
  await import("../../open-sse/translator/response/gemini-to-openai.ts");
const { claudeToOpenAIResponse } =
  await import("../../open-sse/translator/response/claude-to-openai.ts");
test("Gemini translator and accounting agree on cached thinking usage", () => {
  const state: Record<string, unknown> = { toolCalls: new Map(), toolNameMap: new Map() };
  geminiToOpenAIResponse(
    {
      candidates: [
        { index: 0, content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP" },
      ],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 30,
        thoughtsTokenCount: 20,
        cachedContentTokenCount: 30,
        totalTokenCount: 150,
      },
    },
    state
  );
  assert.equal(computeBillableTokens(state.usage), 150);
});
test("translated Anthropic cache creation marked outside prompt is counted once", () => {
  const state: Record<string, unknown> = { toolCalls: new Map(), toolNameMap: new Map() };
  claudeToOpenAIResponse(
    {
      type: "message_start",
      message: {
        id: "fixture",
        model: "claude",
        usage: {
          input_tokens: 60,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 10,
          output_tokens: 0,
        },
      },
    },
    state
  );
  const frames = claudeToOpenAIResponse(
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 50 } },
    state
  );
  const frame = frames?.find((x: { usage?: unknown }) => x.usage);
  assert.ok(frame?.usage);
  assert.equal(computeBillableTokens(frame.usage), 150);
});
