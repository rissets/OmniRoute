/** A trusted CP invocation selects native admission, never a browser-supplied purpose header. */
import { z } from "zod";
import { bridgeIdentity, bridgeRoles } from "./auth";
import { mediaToken } from "./media";
import { governedInference } from "./inference";
import { principal, within, TokenPolicyError, recordMeetingTransport } from "@/lib/db/bpbatam";
import { getApiKeyById } from "@/lib/db/apiKeys";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import {
  completionPolicySchema,
  meetingCompletionInput,
  meetingCompletionObject,
  completionMessages,
  prepareMeetingCompletion,
  completionReceipt,
} from "./meetingCompletion";
import { readRequestBodyWithLimit } from "@/shared/middleware/bodySizeGuard";

import {
  diarizationInput,
  diarizationPolicySchema,
  diarizationAudioSeconds,
  prepareMeetingDiarization,
  forgetMeetingDiarization,
  DIARIZATION_PATH,
} from "./meetingDiarization";

const common = z.object({
  subject: z.string().min(1).max(128),
  issuer: z.string().url().max(500),
  operation_id: z.string().uuid(),
  attempt_id: z.string().uuid(),
});
const sttInput = z
  .object({
    subject: z.string().min(1).max(128),
    issuer: z.string().url().max(500),
    operation: z.literal("stt"),
    input_kind: z.literal("question").optional(),
    operation_id: z.string().uuid(),
    attempt_id: z.string().uuid(),
    policy_revision: z.string().regex(/^[a-f0-9]{64}$/),
    audio_base64: z
      .string()
      .min(60)
      .max(1_333_336)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
const input = z.union([
  z
    .object({
      subject: z.string().min(1).max(128),
      issuer: z.string().url().max(500),
      operation: z.literal("diarization-forget"),
      session_id: z.string().uuid(),
      deployment_id: z.string().min(1).max(200),
    })
    .strict(),
  sttInput,
  common.merge(diarizationInput).strict(),
  common
    .merge(meetingCompletionObject)
    .strict()
    .refine((body) => meetingCompletionInput.safeParse(body).success),
  common
    .extend({
      operation: z.enum(["completion-status", "stt-status", "tts-status", "diarization-status"]),
    })
    .strict(),
  common
    .extend({
      operation: z.literal("tts"),
      answer_id: z.string().uuid(),
      policy_revision: z.string().regex(/^[a-f0-9]{64}$/),
      input: z.string().min(1).max(8000),
    })
    .strict(),
]);
const policy = z.object({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  offer_id: z.string().regex(/^local-(stt|tts)\//),
});

export async function meetingInference(request: Request): Promise<Response> {
  const identity = await bridgeIdentity(request);
  if (!identity) return errorResponse(401, "BRIDGE_AUTH_REQUIRED");
  if (
    identity.azp !==
      (process.env.BPBATAM_MEETING_EXECUTOR_CLIENT_ID ?? "bpbatam-control-plane-service") ||
    !bridgeRoles(identity).includes("bp:meeting-infer")
  )
    return errorResponse(403, "MEETING_EXECUTOR_SCOPE_REQUIRED");
  try {
    const parsed = input.safeParse(
      JSON.parse(new TextDecoder().decode(await readRequestBodyWithLimit(request, 1_500_000)))
    );
    if (!parsed.success) return errorResponse(422, "INVALID_MEETING_INFERENCE");
    const body = parsed.data;
    const owner = principal(body.subject);
    if (
      !owner ||
      (!owner.active && body.operation !== "diarization-forget") ||
      owner.issuer !== body.issuer ||
      !within(owner.account_id, process.env.BPBATAM_CP_ACCOUNT ?? "bpbatam")
    )
      return errorResponse(403, "MEETING_PRINCIPAL_UNAVAILABLE");
    const storedKey = await getApiKeyById(owner.key_id);
    if (!process.env.BPBATAM_MEDIA_EXECUTOR_URL)
      return errorResponse(503, "MEETING_EXECUTOR_UNAVAILABLE");
    const readPolicy = async (kind = "stt") => {
      const selected = await fetch(
        process.env.BPBATAM_MEDIA_EXECUTOR_URL + "/meeting-policy?kind=" + kind,
        {
          headers: { Authorization: "Bearer " + (await mediaToken()) },
          signal: AbortSignal.timeout(15000),
          redirect: "error",
        }
      );
      if (!selected.ok) throw new TokenPolicyError("MEETING_POLICY_UNAVAILABLE", 409);
      if (kind === "diarization") return diarizationPolicySchema.parse(await selected.json());
      return kind === "completion"
        ? completionPolicySchema.parse(await selected.json())
        : policy.parse(await selected.json());
    };
    if (body.operation === "diarization-forget") {
      const current = diarizationPolicySchema.parse(await readPolicy("diarization"));
      return Response.json(
        await forgetMeetingDiarization(current, body.deployment_id, body.session_id),
        { headers: { "Cache-Control": "no-store" } }
      );
    }
    if (typeof storedKey?.key !== "string" || !storedKey.key || !storedKey.isActive)
      return errorResponse(403, "KEY_UNAVAILABLE");
    const key = {
      ...storedKey,
      id: owner.key_id,
      key: storedKey.key,
      name: typeof storedKey.name === "string" ? storedKey.name : undefined,
    };
    if (
      body.operation === "completion-status" ||
      body.operation === "stt-status" ||
      body.operation === "tts-status" ||
      body.operation === "diarization-status"
    ) {
      const receipt = completionReceipt(
        body.subject,
        body.operation_id,
        body.attempt_id,
        body.operation.replace("-status", "")
      );
      return Response.json(
        {
          state: "uncertain",
          error_code: receipt
            ? "MEETING_PRIVATE_OUTPUT_UNAVAILABLE"
            : "MEETING_COMPLETION_UNCONFIRMED",
          ...receipt,
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }
    if (body.operation === "diarization") {
      diarizationAudioSeconds(body.audio_base64);
      const current = diarizationPolicySchema.parse(await readPolicy("diarization"));
      if (current.revision !== body.policy_revision)
        return errorResponse(409, "MEETING_POLICY_CHANGED");
      const existing = completionReceipt(body.subject, body.operation_id, body.attempt_id);
      if (existing)
        return Response.json(
          { state: "uncertain", error_code: "MEETING_PRIVATE_OUTPUT_UNAVAILABLE", ...existing },
          { headers: { "Cache-Control": "no-store" } }
        );
      const plan = await prepareMeetingDiarization(key, current, async () =>
        diarizationPolicySchema.parse(await readPolicy("diarization"))
      );
      const native = new Request(new URL(DIARIZATION_PATH, request.url), {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key.key,
          "Content-Type": "application/json",
          "Idempotency-Key": "meeting:" + body.attempt_id,
        },
        body: JSON.stringify({
          model: current.offer_id,
          session_id: body.session_id,
          chunk_id: body.chunk_id,
          start_ms: body.start_ms,
          audio_base64: body.audio_base64,
          ...(body.retention_seconds != null ? { retention_seconds: body.retention_seconds } : {}),
        }),
      });
      const response = await governedInference(native, plan.dispatch, {
        subject: body.subject,
        operation_id: body.operation_id,
        attempt_id: body.attempt_id,
        policy_revision: body.policy_revision,
        operation_kind: "diarization",
        provenance: { ...plan.provenance, session_id: body.session_id },
      });
      const receipt = completionReceipt(body.subject, body.operation_id, body.attempt_id);
      const completed = response.ok && receipt?.receipt_state === "settled";
      return Response.json(
        {
          state: completed
            ? "completed"
            : receipt && !(receipt.receipt_state === "settled" && receipt.actual_tokens === 0)
              ? "uncertain"
              : "rejected",
          ...(completed
            ? await response.json()
            : { error_code: "MEETING_DIARIZATION_UNAVAILABLE" }),
          ...plan.provenance,
          ...receipt,
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }
    if (body.operation === "tts") {
      const current = policy.parse(await readPolicy("tts"));
      if (current.revision !== body.policy_revision)
        return errorResponse(409, "MEETING_POLICY_CHANGED");
      if (!current.offer_id.startsWith("local-tts/"))
        return errorResponse(403, "MEETING_EXECUTION_PATH_DENIED");
      const existing = completionReceipt(body.subject, body.operation_id, body.attempt_id);
      if (existing)
        return Response.json({
          state: "uncertain",
          error_code: "MEETING_PRIVATE_OUTPUT_UNAVAILABLE",
          ...existing,
        });
      const native = new Request(new URL("/v1/audio/speech", request.url), {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key.key,
          "Content-Type": "application/json",
          "Idempotency-Key": "meeting:" + body.attempt_id,
        },
        body: JSON.stringify({
          model: current.offer_id,
          input: body.input,
          response_format: "wav",
        }),
      });
      const response = await governedInference(
        native,
        () => errorResponse(403, "MEETING_EXECUTION_PATH_DENIED"),
        {
          subject: body.subject,
          operation_id: body.operation_id,
          attempt_id: body.attempt_id,
          policy_revision: body.policy_revision,
          operation_kind: "tts",
          provenance: { answer_id: body.answer_id },
        }
      );
      let receipt = completionReceipt(body.subject, body.operation_id, body.attempt_id);
      const completed = response.ok && receipt?.receipt_state === "settled";
      if (completed && receipt) {
        const provenance: Record<string, string> = {};
        for (const [key, header] of Object.entries({
          deployment_id: "X-Meeting-Deployment",
          adapter_version: "X-Meeting-Adapter",
          model_version: "X-Meeting-Model-Version",
        })) {
          const value = response.headers.get(header);
          if (value && value.length <= 200) provenance[key] = value;
        }
        recordMeetingTransport(receipt.receipt_id, provenance);
        receipt = completionReceipt(body.subject, body.operation_id, body.attempt_id);
      }
      return Response.json(
        {
          state: completed
            ? "completed"
            : receipt && !(receipt.receipt_state === "settled" && receipt.actual_tokens === 0)
              ? "uncertain"
              : "rejected",
          ...receipt,
          ...(completed
            ? {
                audio_base64: Buffer.from(await response.arrayBuffer()).toString("base64"),
                mime_type: response.headers.get("content-type")?.split(";")[0],
                deployment_id: response.headers.get("X-Meeting-Deployment"),
                adapter_version: response.headers.get("X-Meeting-Adapter"),
                model_version: response.headers.get("X-Meeting-Model-Version"),
              }
            : { error_code: "MEETING_SPEECH_UNAVAILABLE" }),
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }
    if (body.operation === "completion") {
      const current = completionPolicySchema.parse(await readPolicy("completion"));
      if (current.revision !== body.policy_revision)
        return errorResponse(409, "MEETING_POLICY_CHANGED");
      const existing = completionReceipt(body.subject, body.operation_id, body.attempt_id);
      if (existing)
        return Response.json({
          state: "uncertain",
          error_code: "MEETING_PRIVATE_OUTPUT_UNAVAILABLE",
          ...existing,
        });
      const plan = await prepareMeetingCompletion(key, current, async () =>
        completionPolicySchema.parse(await readPolicy("completion"))
      );
      const native = new Request(new URL("/v1/chat/completions", request.url), {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key.key,
          "Content-Type": "application/json",
          "Idempotency-Key": "meeting:" + body.attempt_id,
        },
        body: JSON.stringify({
          model: current.offer_id,
          messages: completionMessages(body),
          max_tokens: 4096,
          stream: false,
          temperature: 0,
        }),
      });
      const response = await governedInference(native, plan.dispatch, {
        subject: body.subject,
        operation_id: body.operation_id,
        attempt_id: body.attempt_id,
        policy_revision: body.policy_revision,
        operation_kind: "completion",
        provenance: plan.provenance,
      });
      const receipt = completionReceipt(body.subject, body.operation_id, body.attempt_id);
      const payload = response.ok ? await response.json() : {};
      return Response.json(
        {
          state:
            response.ok && receipt?.receipt_state === "settled"
              ? "completed"
              : receipt && !(receipt.receipt_state === "settled" && receipt.actual_tokens === 0)
                ? "uncertain"
                : "rejected",
          ...payload,
          ...plan.provenance,
          ...receipt,
          policy_revision: body.policy_revision,
          ...(!response.ok ? { error_code: "MEETING_COMPLETION_UNAVAILABLE" } : {}),
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }
    if (body.operation !== "stt") return errorResponse(422, "INVALID_MEETING_INFERENCE");
    const current = policy.parse(await readPolicy());
    if (!current.offer_id.startsWith("local-stt/"))
      return errorResponse(403, "MEETING_EXECUTION_PATH_DENIED");
    if (current.revision !== body.policy_revision)
      return errorResponse(409, "MEETING_POLICY_CHANGED");
    const audio = Buffer.from(body.audio_base64, "base64");
    if (
      audio.toString("base64") !== body.audio_base64 ||
      audio.length > 1_000_000 ||
      audio.subarray(0, 4).toString() !== "RIFF" ||
      audio.subarray(8, 12).toString() !== "WAVE"
    )
      return errorResponse(400, "MEETING_WAV_REQUIRED");
    const form = new FormData();
    form.set("model", current.offer_id);
    form.set(
      "file",
      new Blob([audio], { type: "audio/wav" }),
      body.input_kind === "question" ? "question.wav" : "frame.wav"
    );
    const native = new Request(new URL("/v1/audio/transcriptions", request.url), {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key.key,
        "Idempotency-Key": "meeting:" + body.attempt_id,
      },
      body: form,
    });
    const response = await governedInference(
      native,
      () => errorResponse(403, "MEETING_EXECUTION_PATH_DENIED"),
      {
        subject: body.subject,
        operation_id: body.operation_id,
        attempt_id: body.attempt_id,
        policy_revision: body.policy_revision,
        ...(body.input_kind === "question" ? { provenance: { input_kind: "question" } } : {}),
      }
    );
    if (!response.ok) return response;
    return Response.json(
      { ...(await response.json()), receipt_id: response.headers.get("x-bpbatam-receipt") },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return errorResponse(
      error instanceof TokenPolicyError ? error.status : 503,
      error instanceof TokenPolicyError ? error.code : "MEETING_INFERENCE_UNAVAILABLE"
    );
  }
}
