import { deniedRequest } from "@/lib/db/bpbatamEvents";
import { admissionContext, holdUnsettled } from "./context";
import { randomUUID } from "node:crypto";
import { getApiKeyMetadata } from "@/lib/db/apiKeys";
import {
  getTokenLimitsForRequest,
  listTokenLimits,
  resetWindowIfElapsed,
} from "@/lib/db/tokenLimits";
import { getCurrentWindowUsage } from "@omniroute/open-sse/services/tokenLimitCounter.ts";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { principalForKey, reserve, settle, TokenPolicyError } from "@/lib/db/bpbatam";
import { reservationBound, BoundError } from "./usage";
import { usesMediaExecutor, prepareMediaExecution, executeMedia } from "./mediaExecutor";
import { integratedMedia } from "./media";
import {
  readRequestBodyWithLimit,
  RequestBodyTooLargeError,
  getBodySizeLimit,
} from "@/shared/middleware/bodySizeGuard";
import { getCachedSettings } from "@/lib/db/readCache";

export const GOVERNED_PATHS = new Set([
  "/v1/chat/completions",
  "/v1/audio/speech",
  "/v1/audio/transcriptions",
  "/v1/images/generations",
  "/v1/images/edits",
  "/v1/embeddings",
]);
export async function governedInference(
  request: Request,
  dispatch: (request: Request) => Response | Promise<Response>
): Promise<Response> {
  const secret =
    request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1] ??
    request.headers.get("x-api-key");
  if (!secret) return dispatch(request);
  const key = await getApiKeyMetadata(secret);
  if (!key?.id) return dispatch(request);
  const owner = principalForKey(key.id);
  const allLimits = listTokenLimits(key.id);
  if (!owner && !allLimits.length) return dispatch(request);
  const path = new URL(request.url).pathname.replace(/^\/api\/v1/, "/v1");
  let id: string | undefined;
  let admitted = false;
  let requestedModel: string | null = null;
  try {
    if (
      owner &&
      integratedMedia() &&
      [
        "/v1/audio/speech",
        "/v1/audio/transcriptions",
        "/v1/images/generations",
        "/v1/images/edits",
      ].includes(path)
    ) {
      const mime = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      const valid =
        path === "/v1/audio/transcriptions"
          ? mime === "multipart/form-data"
          : path === "/v1/images/edits"
            ? ["application/json", "multipart/form-data"].includes(mime ?? "")
            : mime === "application/json";
      if (!valid) throw new TokenPolicyError("MEDIA_CONTENT_TYPE_UNSUPPORTED", 415);
      const limit = Math.min(
        32 * 1024 * 1024,
        getBodySizeLimit(path.replace(/^\/v1/, "/api/v1"), await getCachedSettings())
      );
      const bytes = await readRequestBodyWithLimit(request, limit);
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      request = new Request(request.url, {
        method: request.method,
        headers,
        body: bytes,
        signal: request.signal,
      });
    }
    let body: Record<string, unknown> = {};
    if (request.headers.get("content-type")?.includes("application/json"))
      body = await request.clone().json();
    else {
      const form = await request.clone().formData();
      body = { model: form.get("model") };
    }
    const model = typeof body.model === "string" ? body.model : "";
    requestedModel = model;
    const policy = await enforceApiKeyPolicy(request, model);
    if (policy.rejection) return policy.rejection;
    const mediaRevision =
      owner && usesMediaExecutor(path, model)
        ? await prepareMediaExecution(key, path, model)
        : undefined;
    let units: number | undefined;
    if (path !== "/v1/chat/completions" && path !== "/v1/embeddings") {
      const configured = JSON.parse(process.env.BPBATAM_MEDIA_TOKEN_UNITS ?? "{}");
      units = configured[path];
      if (typeof units !== "number" || !Number.isSafeInteger(units) || units <= 0)
        return errorResponse(503, "MEDIA_UNIT_POLICY_REQUIRED");
    }
    const amount =
      units ??
      (path === "/v1/embeddings"
        ? new TextEncoder().encode(JSON.stringify(body.input ?? "")).length + 128
        : reservationBound(body));
    const current = getTokenLimitsForRequest(key.id, "", model).map((limit) => ({
      id: limit.id,
      window: resetWindowIfElapsed(limit).windowStart,
      limit: limit.tokenLimit,
      used: getCurrentWindowUsage(limit, Date.now(), true),
    }));
    const supplied = request.headers.get("idempotency-key");
    if (supplied && (supplied.length > 128 || !/^[a-zA-Z0-9:_-]+$/.test(supplied)))
      return errorResponse(400, "INVALID_IDEMPOTENCY_KEY");
    id = key.id + ":" + (supplied ?? randomUUID());
    reserve(id, key.id, amount, path, model, current, owner?.policy_revision);
    admitted = true;
    let forwarded = request;
    if (owner && body.stream === true && path === "/v1/chat/completions") {
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      forwarded = new Request(request, {
        headers,
        body: JSON.stringify({
          ...body,
          stream_options: { ...((body.stream_options as object) ?? {}), include_usage: true },
        }),
      });
    }
    const operation = {
      id,
      failed: false,
      dispatched: false,
      outputLimit: Number(
        body.max_completion_tokens ?? body.max_tokens ?? body.max_output_tokens ?? 0
      ),
    };
    const response = await admissionContext.run(operation, () =>
      mediaRevision
        ? executeMedia(forwarded, path, model, id!, mediaRevision, key)
        : dispatch(forwarded)
    );
    const headers = new Headers(response.headers);
    headers.set("x-bpbatam-receipt", id);
    headers.delete("X-CP-Media-State");
    headers.delete("X-CP-Media-Audio-Seconds");
    if (!response.ok) {
      if (
        (mediaRevision && response.headers.get("X-CP-Media-State") === "rejected") ||
        (path === "/v1/chat/completions" && !operation.dispatched)
      )
        settle(id, 0, { reason: "trusted_local_rejection_before_dispatch" });
      else holdUnsettled(id, "upstream_or_handler_failure");
      return new Response(response.body, { status: response.status, headers });
    }
    if (path === "/v1/embeddings") {
      const receipt = await response
        .clone()
        .json()
        .catch(() => null);
      const used = receipt?.usage?.total_tokens;
      settle(
        id,
        typeof used === "number" && Number.isSafeInteger(used) && used >= 0 ? used : null,
        { input: used, output: 0, total: used, unit: "provider-token", version: 1 }
      );
      return new Response(response.body, { status: response.status, headers });
    }
    if (units) {
      if (mediaRevision && response.headers.get("X-CP-Media-State") !== "completed") {
        holdUnsettled(id, "media_execution_confirmation_missing");
        return errorResponse(503, "MEDIA_EXECUTION_CONFIRMATION_MISSING");
      }
      const seconds = Number(response.headers.get("X-CP-Media-Audio-Seconds") ?? 0);
      settle(id, units, {
        unit: "router-media-token-equivalent",
        version: 1,
        total: units,
        ...(path === "/v1/audio/transcriptions" && Number.isFinite(seconds) && seconds > 0
          ? { audio_seconds: seconds }
          : {}),
      });
      return new Response(response.body, { status: response.status, headers });
    }
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
      holdUnsettled(id, "provider_receipt_not_recorded");
      return new Response(response.body, { status: response.status, headers });
    }
    const reader = response.body!.getReader();
    const receipt = id;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            holdUnsettled(receipt, "provider_receipt_not_recorded");
            controller.close();
            return;
          }
          controller.enqueue(chunk.value);
        } catch (error) {
          holdUnsettled(receipt, "stream_interrupted");
          controller.error(error);
        }
      },
      async cancel() {
        holdUnsettled(receipt, "client_disconnect");
        await reader.cancel();
      },
    });
    headers.delete("content-length");
    return new Response(stream, { status: response.status, headers });
  } catch (error) {
    if (id && admitted) holdUnsettled(id, "dispatch_interrupted");
    const denial =
      error instanceof TokenPolicyError
        ? { code: error.code, status: error.status }
        : error instanceof BoundError
          ? { code: error.code, status: 400 }
          : error instanceof SyntaxError
            ? { code: "INVALID_JSON_BODY", status: 400 }
            : error instanceof RequestBodyTooLargeError
              ? { code: "MEDIA_INPUT_TOO_LARGE", status: 413 }
              : null;
    if (!admitted && owner && denial) {
      const requestId = deniedRequest(owner, key.id, path, requestedModel, denial.code);
      const response = errorResponse(denial.status, denial.code);
      response.headers.set("X-BPbatam-Request", requestId);
      return response;
    }
    if (error instanceof TokenPolicyError) return errorResponse(error.status, error.code);
    if (error instanceof BoundError) return errorResponse(400, error.code);
    if (error instanceof RequestBodyTooLargeError)
      return errorResponse(413, "MEDIA_INPUT_TOO_LARGE");
    return errorResponse(503, "TOKEN_ADMISSION_UNAVAILABLE");
  }
}
