export class BoundError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export interface CanonicalUsage {
  input: number;
  output: number;
  reasoning: number;
  cached: number;
  total: number;
  unit: string;
  version: number;
}
const count = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export function canonicalUsage(value: unknown): CanonicalUsage | null {
  if (!value || typeof value !== "object") return null;
  const u = value as Record<string, unknown>;
  if (u.estimated) return null;
  const gemini = (u.usageMetadata ?? u) as Record<string, unknown>;
  if (count(gemini.promptTokenCount) && count(gemini.candidatesTokenCount)) {
    const thought = count(gemini.thoughtsTokenCount) ? gemini.thoughtsTokenCount : 0;
    const total = count(gemini.totalTokenCount)
      ? gemini.totalTokenCount
      : gemini.promptTokenCount + gemini.candidatesTokenCount + thought;
    if (total < gemini.promptTokenCount) return null;
    return {
      input: gemini.promptTokenCount,
      output: total - gemini.promptTokenCount,
      reasoning: thought,
      cached: count(gemini.cachedContentTokenCount) ? gemini.cachedContentTokenCount : 0,
      total,
      unit: "provider-token",
      version: 1,
    };
  }
  const input = u.prompt_tokens ?? u.input_tokens ?? u.input;
  const output = u.completion_tokens ?? u.output_tokens ?? u.output;
  if (!count(input) || !count(output)) return null;
  const anthropic =
    u.prompt_tokens == null &&
    (u.cache_read_input_tokens != null || u.cache_creation_input_tokens != null);
  const cache = count(u.cache_read_input_tokens) ? u.cache_read_input_tokens : 0;
  const write = count(u.cache_creation_input_tokens) ? u.cache_creation_input_tokens : 0;
  const promptDetails = (u.prompt_tokens_details ?? u.input_tokens_details ?? {}) as Record<
    string,
    unknown
  >;
  const separateWrite =
    promptDetails.cache_creation_in_prompt === false && count(promptDetails.cache_creation_tokens)
      ? promptDetails.cache_creation_tokens
      : 0;
  const actualInput = input + (anthropic ? cache + write : 0) + separateWrite;
  const details = (u.completion_tokens_details ?? u.output_tokens_details ?? {}) as Record<
    string,
    unknown
  >;
  const prompt = (u.prompt_tokens_details ?? u.input_tokens_details ?? {}) as Record<
    string,
    unknown
  >;
  const reasoning = count(details.reasoning_tokens) ? details.reasoning_tokens : 0;
  const total = actualInput + output;
  if (count(u.total_tokens) && u.total_tokens + separateWrite !== total) return null;
  return {
    input: actualInput,
    output,
    reasoning,
    cached: count(prompt.cached_tokens) ? prompt.cached_tokens : cache,
    total,
    unit: "provider-token",
    version: 1,
  };
}
export function reservationBound(body: Record<string, unknown>): number {
  const max = body.max_completion_tokens ?? body.max_tokens ?? body.max_output_tokens;
  if (!count(max) || max < 1) throw new BoundError("OUTPUT_LIMIT_REQUIRED");
  // One token cannot encode less than one input byte. Include serialized messages/tools and
  // conservative framing; image/audio input needs provider-specific bounds and is denied here.
  if (
    JSON.stringify(body.messages ?? []).includes("image_url") ||
    JSON.stringify(body.messages ?? []).includes("input_audio")
  )
    throw new BoundError("MULTIMODAL_BOUND_REQUIRED");
  return (
    Buffer.byteLength(JSON.stringify(body.messages ?? [])) +
    Buffer.byteLength(JSON.stringify(body.tools ?? [])) +
    128 +
    max
  );
}
