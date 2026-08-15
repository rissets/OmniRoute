import assert from "node:assert/strict";
import test from "node:test";

import { normalizeOpenAiToolCallSseResponse } from "../../src/lib/openAiToolCallSseCompatibility";

function event(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

test("removes null identity fields from streamed tool-call continuation chunks", async () => {
  const first = {
    choices: [
      {
        index: 0,
        delta: {
          role: null,
          content: null,
          tool_calls: [
            {
              index: 0,
              id: "call_image_1",
              type: "function",
              function: { name: "image_gen_oai", arguments: "" },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
  const continuation = {
    choices: [
      {
        index: 0,
        delta: {
          role: null,
          content: null,
          tool_calls: [
            {
              index: 0,
              id: null,
              type: "function",
              function: { name: null, arguments: '{"prompt":"kucing astronot"}' },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
  const source = `${event(first)}${event(continuation)}data: [DONE]\n\n`;
  const response = new Response(source, {
    headers: {
      "Content-Length": String(source.length),
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Test": "preserved",
    },
  });

  const normalized = normalizeOpenAiToolCallSseResponse(response);
  const lines = (await normalized.text())
    .split("\n")
    .filter((line) => line.startsWith("data: {") && line.endsWith("}"));
  const secondPayload = JSON.parse(lines[1].slice(6));
  const toolCall = secondPayload.choices[0].delta.tool_calls[0];

  assert.equal(toolCall.index, 0);
  assert.equal(toolCall.type, "function");
  assert.equal(toolCall.function.arguments, '{"prompt":"kucing astronot"}');
  assert.equal("id" in toolCall, false);
  assert.equal("name" in toolCall.function, false);
  assert.equal(normalized.headers.get("content-length"), null);
  assert.equal(normalized.headers.get("x-test"), "preserved");
});

test("leaves non-SSE responses untouched", () => {
  const response = new Response('{"ok":true}', {
    status: 202,
    headers: { "Content-Type": "application/json" },
  });

  assert.equal(normalizeOpenAiToolCallSseResponse(response), response);
});
