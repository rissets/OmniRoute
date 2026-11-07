/** Governed local speaker embedding lane. Never enters generic STT or chat dispatch. */
import { isIP } from "node:net";
import { z } from "zod";
import { getApiKeyById } from "@/lib/db/apiKeys";
import { getProviderNodeById } from "@/lib/db/providers/nodes";
import { getProviderConnectionById } from "@/lib/db/providers";
import {
  TokenPolicyError,
  recordMeetingTransport,
  admission,
  meetingAdmission,
} from "@/lib/db/bpbatam";
import { getProviderCredentialsWithQuotaPreflight } from "@/sse/services/auth";
import { createVisibleResolvedModelGate } from "@/sse/handlers/chat/resolvedModelPolicy";
import { resolveConnectionRestrictions } from "@/sse/services/connectionRestrictions";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { calculateModalCost } from "@/lib/usage/costCalculator";
import { recordModalCallCost, recordUnpricedBudgetUsage } from "@/domain/costRules";
import { getPricingForModel } from "@/lib/db/settings/pricing";
import { admissionContext, governedAttempt, governedAttemptResult } from "./context";
import { managedPolicy, managedResolvedAllowed, publishedOffers } from "./offers";
import { pinnedMeetingPost } from "./meetingTransport";

export const DIARIZATION_PATH = "/v1/audio/diarizations";
export const DIARIZATION_MODEL_VERSION = "sherpa-onnx-1.12.32-pyannote3-wespeaker-resnet34-lm-v1";
const fail = (code: string, status = 403): never => {
  throw new TokenPolicyError(code, status);
};
export const diarizationInput = z.object({
  operation: z.literal("diarization"),
  policy_revision: z.string().regex(/^[a-f0-9]{64}$/),
  session_id: z.string().uuid(),
  chunk_id: z.string().uuid(),
  start_ms: z.number().int().min(0).max(86400000),
  retention_seconds: z.number().int().min(1).max(300).optional(),
  audio_base64: z
    .string()
    .min(60)
    .max(1280060)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
export const diarizationPolicySchema = z.object({
  kind: z.literal("diarization"),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  offer_id: z
    .string()
    .regex(/^local-stt\//)
    .max(200),
  deployments: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        kind: z.literal("diarization"),
        base_url: z.string().url(),
        provider: z.string().min(1),
        connection_id: z.string().min(1),
        model: z.string().min(1),
        ip_addresses: z
          .array(z.string().refine((ip) => isIP(ip) > 0))
          .min(1)
          .max(16),
        attestation_id: z.string().min(1),
        adapter_version: z.literal("speaker-embedding-v1"),
        model_version: z.literal(DIARIZATION_MODEL_VERSION),
      })
    )
    .min(1)
    .max(16),
});
type Policy = z.infer<typeof diarizationPolicySchema>;
type Deployment = Policy["deployments"][number];
type Key = {
  id: string;
  key?: string;
  name?: string;
  allowedConnections?: unknown;
  allowedQuotas?: unknown;
  proxyId?: unknown;
};
type Dispatch = (request: Request) => Response | Promise<Response>;
const audited = new WeakMap<Dispatch, string>();
export function meetingDiarizationProvider(
  dispatch: (request: Request) => Response | Promise<Response>
) {
  return audited.get(dispatch);
}
export function isMeetingDiarizationDispatch(
  dispatch: (request: Request) => Response | Promise<Response>
) {
  return audited.has(dispatch);
}

/** Read all RIFF chunks; reject compressed, stereo, resampled, truncated and ambiguous WAVs. */
export function diarizationAudioSeconds(encoded: string): number {
  const wav = Buffer.from(encoded, "base64");
  if (
    wav.toString("base64") !== encoded ||
    wav.length > 960100 ||
    wav.length < 44 ||
    wav.toString("ascii", 0, 4) !== "RIFF" ||
    wav.toString("ascii", 8, 12) !== "WAVE" ||
    wav.readUInt32LE(4) + 8 !== wav.length
  )
    fail("MEETING_WAV_REQUIRED", 400);
  let offset = 12,
    format = false,
    dataBytes = -1;
  while (offset + 8 <= wav.length) {
    const kind = wav.toString("ascii", offset, offset + 4),
      size = wav.readUInt32LE(offset + 4);
    const start = offset + 8,
      end = start + size;
    if (end > wav.length) fail("MEETING_WAV_REQUIRED", 400);
    if (kind === "fmt ") {
      if (
        format ||
        size !== 16 ||
        wav.readUInt16LE(start) !== 1 ||
        wav.readUInt16LE(start + 2) !== 1 ||
        wav.readUInt32LE(start + 4) !== 16000 ||
        wav.readUInt32LE(start + 8) !== 32000 ||
        wav.readUInt16LE(start + 12) !== 2 ||
        wav.readUInt16LE(start + 14) !== 16
      )
        fail("MEETING_WAV_REQUIRED", 400);
      format = true;
    } else if (kind === "data") {
      if (dataBytes !== -1 || size % 32) fail("MEETING_WAV_REQUIRED", 400);
      dataBytes = size;
    } else fail("MEETING_WAV_REQUIRED", 400);
    offset = end + (size % 2);
  }
  const seconds = dataBytes / 32000;
  if (!format || offset !== wav.length || seconds < 0.1 || seconds > 30)
    fail("MEETING_WAV_REQUIRED", 400);
  return seconds;
}

const modelSchema = z
  .object({
    id: z.literal("sherpa-onnx-offline-diarization"),
    revision: z.literal(DIARIZATION_MODEL_VERSION),
    segmentation: z.literal("pyannote-segmentation-3-0"),
    embedding: z.literal("wespeaker-en-voxceleb-resnet34-LM"),
    runtime: z.literal("sherpa-onnx"),
    runtime_version: z.literal("1.12.32"),
    provider: z.literal("cpu"),
    sha256: z
      .object({
        segmentation: z.literal("220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079"),
        embedding: z.literal("e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012"),
      })
      .strict(),
  })
  .strict();
const resultSchema = z
  .object({
    session_id: z.string().uuid(),
    chunk_id: z.string().uuid(),
    session_epoch: z.string().uuid(),
    status: z.enum(["ready", "insufficient_audio", "no_speech"]),
    analyzed_start_ms: z.number().int().nonnegative(),
    analyzed_end_ms: z.number().int().nonnegative(),
    adapter_version: z.literal("speaker-embedding-v1"),
    model_version: z.literal(DIARIZATION_MODEL_VERSION),
    model: modelSchema,
    warnings: z.array(z.string().max(200)).max(20),
    segments: z
      .array(
        z
          .object({
            start_ms: z.number().int().nonnegative(),
            end_ms: z.number().int().nonnegative(),
            speaker: z
              .string()
              .regex(/^speaker_[0-9]{1,4}$/)
              .nullable(),
            overlap: z.boolean().optional(),
          })
          .strict()
      )
      .max(500),
  })
  .strict();

async function wireIdentity(deployment: Deployment) {
  const [node, connection] = await Promise.all([
    getProviderNodeById(deployment.provider),
    getProviderConnectionById(deployment.connection_id),
  ]);
  if (
    !node ||
    node.prefix !== "local-stt" ||
    !["stt", "transcription", "audio", "audio-transcriptions", null, undefined].includes(
      node.apiType as string
    )
  )
    fail("MEETING_ADAPTER_UNSUPPORTED");
  if (
    !connection?.isActive ||
    connection.provider !== deployment.provider ||
    connection.authType !== "apikey" ||
    !connection.apiKey ||
    connection.proxyEnabled !== false ||
    connection.perKeyProxyEnabled === true ||
    connection.proxyId ||
    connection.proxyUrl ||
    connection.accessToken ||
    connection.refreshToken
  )
    fail("MEETING_TRANSPORT_UNSUPPORTED");
  const data = (connection.providerSpecificData ?? {}) as Record<string, unknown>;
  const harmless = new Set([
    "baseUrl",
    "apiType",
    "prefix",
    "nodeName",
    "autoFetchModels",
    "quotaWindowThresholds",
    "quotaPreflightEnabled",
  ]);
  for (const [key, value] of Object.entries(data))
    if (!harmless.has(key) && value != null && value !== false && value !== "")
      fail("MEETING_TRANSPORT_UNSUPPORTED");
  if (
    data.apiType &&
    !["stt", "transcription", "audio", "audio-transcriptions"].includes(String(data.apiType))
  )
    fail("MEETING_ADAPTER_UNSUPPORTED");
  const base = String(data.baseUrl || node.baseUrl || "").replace(/\/$/, "");
  if (base !== deployment.base_url) fail("MEETING_DESTINATION_DENIED");
  const url = new URL(base + "/diarize");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    fail("MEETING_DESTINATION_DENIED");
  return { url, connection };
}

export async function prepareMeetingDiarization(
  key: Key,
  policy: Policy,
  refresh: () => Promise<Policy>
) {
  if (key.proxyId) fail("MEETING_TRANSPORT_UNSUPPORTED");
  const live = (await publishedOffers()).find(
    (offer) =>
      offer.id === policy.offer_id &&
      offer.kind === "model" &&
      offer.capabilities?.includes("transcribe")
  );
  if (!live || (await managedPolicy(key.id, DIARIZATION_PATH, policy.offer_id)))
    fail("MEETING_OFFER_UNAVAILABLE");
  const restrictions = resolveConnectionRestrictions(key, null, false);
  for (const deployment of policy.deployments) {
    if (
      policy.offer_id !== "local-stt/" + deployment.model ||
      (await managedResolvedAllowed(key.id, deployment.provider + "/" + deployment.model)) !==
        true ||
      (restrictions.allowedConnections != null &&
        !restrictions.allowedConnections.includes(deployment.connection_id))
    )
      continue;
    await wireIdentity(deployment);
    const credentials = await getProviderCredentialsWithQuotaPreflight(
      deployment.provider,
      null,
      [deployment.connection_id],
      deployment.model,
      { connectionRestrictionSources: restrictions.sources }
    );
    if (
      !credentials ||
      !("connectionId" in credentials) ||
      !("apiKey" in credentials) ||
      !credentials.apiKey ||
      credentials.connectionId !== deployment.connection_id
    )
      continue;
    const provenance = {
      deployment_id: deployment.id,
      adapter_version: deployment.adapter_version,
      model_version: deployment.model_version,
      provider: deployment.provider,
      model: deployment.model,
      connection_id: deployment.connection_id,
    };
    const dispatch: Dispatch = async (request) => {
      const operation = admissionContext.getStore();
      const admitted = operation ? admission(operation.id) : null;
      const link = operation ? meetingAdmission(operation.id) : null;
      if (
        !admitted ||
        admitted.state !== "reserved" ||
        admitted.key_id !== key.id ||
        admitted.endpoint !== DIARIZATION_PATH ||
        link?.operation_kind !== "diarization" ||
        link.policy_revision !== policy.revision
      )
        fail("MEETING_ADMISSION_REQUIRED");
      const current = await refresh();
      if (
        current.revision !== policy.revision ||
        JSON.stringify(current) !== JSON.stringify(policy)
      )
        fail("MEETING_POLICY_CHANGED", 409);
      const active = await getApiKeyById(key.id);
      if (
        !active?.isActive ||
        active.isBanned ||
        (active.expiresAt && Date.parse(String(active.expiresAt)) <= Date.now())
      )
        fail("KEY_UNAVAILABLE");
      if (
        (await managedPolicy(key.id, DIARIZATION_PATH, policy.offer_id)) ||
        (await managedResolvedAllowed(key.id, deployment.provider + "/" + deployment.model)) !==
          true
      )
        fail("MEETING_TARGET_DENIED");
      const gate = createVisibleResolvedModelGate({
        apiKeyInfo: active,
        apiKey: String(active.key),
        contextModel: policy.offer_id,
        comboGrantsTargets: false,
        provider: deployment.provider,
        model: deployment.model,
        modelStr: policy.offer_id,
      });
      if (await gate([deployment.provider + "/" + deployment.model])) fail("MEETING_TARGET_DENIED");
      const scoped = resolveConnectionRestrictions(active, null, false);
      if (
        scoped.allowedConnections != null &&
        !scoped.allowedConnections.includes(deployment.connection_id)
      )
        fail("MEETING_TARGET_DENIED");
      const fresh = await getProviderCredentialsWithQuotaPreflight(
        deployment.provider,
        null,
        [deployment.connection_id],
        deployment.model,
        { connectionRestrictionSources: scoped.sources }
      );
      if (
        !fresh ||
        !("connectionId" in fresh) ||
        !("apiKey" in fresh) ||
        !fresh.apiKey ||
        fresh.connectionId !== deployment.connection_id
      )
        fail("MEETING_TARGET_UNAVAILABLE");
      const wire = await wireIdentity(deployment);
      const { model: _model, ...payload } = await request.json();
      const seconds = diarizationAudioSeconds(payload.audio_base64);
      let attempt: number | null = null;
      try {
        const response = await pinnedMeetingPost(
          wire.url,
          deployment,
          String(wire.connection.apiKey),
          JSON.stringify(payload),
          (address) => {
            const receipt = admissionContext.getStore()?.id;
            if (receipt)
              recordMeetingTransport(receipt, {
                destination_url: wire.url.toString(),
                ip_address: address,
                transport: "direct-pinned",
                attestation_id: deployment.attestation_id,
              });
            attempt = governedAttempt(deployment.provider, deployment.model);
          }
        );
        governedAttemptResult(attempt, deployment.provider, deployment.model, response.status);
        if (response.status !== 200) return errorResponse(503, "MEETING_DIARIZATION_UNAVAILABLE");
        const result = resultSchema.parse(JSON.parse(response.body));
        const end = payload.start_ms + seconds * 1000;
        if (
          result.session_id !== payload.session_id ||
          result.chunk_id !== payload.chunk_id ||
          result.analyzed_start_ms < Math.max(0, end - 20000) ||
          result.analyzed_end_ms !== end ||
          result.analyzed_start_ms > end ||
          result.segments.some(
            (segment) =>
              segment.start_ms < result.analyzed_start_ms ||
              segment.end_ms > end ||
              segment.start_ms >= segment.end_ms
          ) ||
          (result.status !== "ready" && result.segments.length)
        )
          fail("MEETING_DIARIZATION_INVALID", 503);
        const pricing = (await getPricingForModel(deployment.provider, deployment.model)) as Record<
          string,
          unknown
        > | null;
        if (
          !pricing ||
          !["input_cost_per_second", "output_cost_per_second"].some(
            (name) =>
              typeof pricing[name] === "number" &&
              Number.isFinite(pricing[name]) &&
              Number(pricing[name]) >= 0
          )
        )
          recordUnpricedBudgetUsage(key.id, {
            provider: deployment.provider,
            model: deployment.model,
          });
        const costUsd = await calculateModalCost("audio", deployment.provider, deployment.model, {
          seconds,
        });
        recordModalCallCost(key.id, {
          provider: deployment.provider,
          model: deployment.model,
          costUsd,
        });
        return Response.json(
          { ...result, ...provenance },
          {
            headers: {
              "X-CP-Media-State": "completed",
              "X-CP-Media-Audio-Seconds": String(seconds),
            },
          }
        );
      } catch {
        governedAttemptResult(attempt, deployment.provider, deployment.model);
        return errorResponse(503, "MEETING_DIARIZATION_UNCONFIRMED");
      }
    };
    audited.set(dispatch, deployment.provider);
    return { dispatch, provenance };
  }
  fail("MEETING_TARGET_UNAVAILABLE", 503);
}

/** Nonbillable erasure uses only a currently registered attested target, never user entitlements. */
export async function forgetMeetingDiarization(
  policy: Policy,
  deploymentId: string,
  sessionId: string
) {
  const deployment = policy.deployments.find((entry) => entry.id === deploymentId);
  if (!deployment) fail("MEETING_DIARIZATION_CLEANUP_TARGET_UNAVAILABLE", 409);
  const wire = await wireIdentity(deployment);
  const url = new URL(wire.url);
  url.pathname = url.pathname.replace(/\/diarize$/, "/sessions/" + sessionId.toLowerCase());
  const response = await pinnedMeetingPost(
    url,
    deployment,
    String(wire.connection.apiKey),
    "",
    () => {},
    "DELETE"
  );
  if (response.status !== 200) fail("MEETING_DIARIZATION_CLEANUP_UNAVAILABLE", 503);
  const parsed = z
    .object({ forgotten: z.literal(true), session_id: z.string().uuid() })
    .strict()
    .safeParse(JSON.parse(response.body));
  if (!parsed.success || parsed.data.session_id !== sessionId.toLowerCase())
    fail("MEETING_DIARIZATION_CLEANUP_UNCONFIRMED", 503);
  return parsed.data;
}
