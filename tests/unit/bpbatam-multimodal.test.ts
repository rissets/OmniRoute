import test from "node:test";
import assert from "node:assert/strict";
import { reservationBound } from "../../src/lib/bpbatam/usage.ts";

const image = {
  model: "bp-batam-qwen",
  max_tokens: 8192,
  messages: [
    {
      role: "user",
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,fixture" } }],
    },
  ],
};

test("multimodal input reserves the configured full model context plus output", () => {
  assert.equal(reservationBound(image, { "bp-batam-qwen": 128000 }), 136192);
});
test("clients cannot supply their own multimodal bound", () => {
  assert.throws(
    () => reservationBound({ ...image, input_token_bound: 1 }),
    /MULTIMODAL_BOUND_REQUIRED/
  );
  assert.throws(
    () => reservationBound({ ...image, model: "unconfigured" }, { "bp-batam-qwen": 128000 }),
    /MULTIMODAL_BOUND_REQUIRED/
  );
});
test("invalid configured bounds fail closed", () => {
  for (const bound of [0, -1, 1.5, "128000", Number.MAX_SAFE_INTEGER]) {
    assert.throws(
      () => reservationBound(image, { "bp-batam-qwen": bound }),
      /MULTIMODAL_BOUND_REQUIRED/
    );
  }
});
test("text requests retain their existing serialized input reservation", () => {
  const body = {
    model: "bp-batam-qwen",
    max_tokens: 500,
    messages: [{ role: "user", content: "Hello" }],
  };
  assert.equal(
    reservationBound(body, { "bp-batam-qwen": 128000 }),
    Buffer.byteLength(JSON.stringify(body.messages)) + 2 + 128 + 500
  );
});
