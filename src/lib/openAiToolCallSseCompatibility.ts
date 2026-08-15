type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deleteNull(record: JsonRecord, key: string): boolean {
  if (record[key] !== null) return false;
  delete record[key];
  return true;
}

function normalizeToolCall(toolCall: unknown): boolean {
  if (!isRecord(toolCall)) return false;

  let changed = deleteNull(toolCall, "id");
  changed = deleteNull(toolCall, "type") || changed;

  const fn = toolCall.function;
  if (!isRecord(fn)) return changed;

  changed = deleteNull(fn, "name") || changed;
  changed = deleteNull(fn, "arguments") || changed;
  return changed;
}

function normalizeChoice(choice: unknown): boolean {
  if (!isRecord(choice) || !isRecord(choice.delta)) return false;
  const toolCalls = choice.delta.tool_calls;
  if (!Array.isArray(toolCalls)) return false;

  let changed = false;
  for (const toolCall of toolCalls) {
    changed = normalizeToolCall(toolCall) || changed;
  }
  return changed;
}

function normalizePayload(payload: unknown): boolean {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return false;

  let changed = false;
  for (const choice of payload.choices) {
    changed = normalizeChoice(choice) || changed;
  }
  return changed;
}

function normalizeDataLine(line: string): string {
  if (!line.startsWith("data:")) return line;

  const prefix = line.startsWith("data: ") ? "data: " : "data:";
  const raw = line.slice(prefix.length);
  if (raw.trim() === "[DONE]") return line;

  try {
    const payload: unknown = JSON.parse(raw);
    return normalizePayload(payload) ? `${prefix}${JSON.stringify(payload)}` : line;
  } catch {
    return line;
  }
}

function createToolCallCompatibilityTransform(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        controller.enqueue(encoder.encode(`${normalizeDataLine(line)}\n`));
      }
    },
    flush(controller) {
      buffer = decoder.decode() + buffer;
      if (buffer) controller.enqueue(encoder.encode(normalizeDataLine(buffer)));
    },
  });
}

/**
 * OpenAI continuation chunks omit tool identity fields after the opening delta.
 * Some compatible providers serialize those optional fields as `null`, which
 * resets LangChain's streamed tool-call accumulator and discards the arguments.
 */
export function normalizeOpenAiToolCallSseResponse(response: Response): Response {
  if (!response.body) return response;
  if (!response.headers.get("content-type")?.includes("text/event-stream")) return response;

  const headers = new Headers(response.headers);
  headers.delete("content-length");

  return new Response(response.body.pipeThrough(createToolCallCompatibilityTransform()), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
