/** Native policy, ledger and financial accounting stay here; CP only executes providers. */
import { integratedMedia, mediaCatalogRevision, mediaToken } from "./media";
import { principalForKey, TokenPolicyError } from "@/lib/db/bpbatam";
import { calculateModalCost, calculateCostDetailed } from "@/lib/usage/costCalculator";
import { recordModalCallCost, recordUnpricedBudgetUsage } from "@/domain/costRules";
import { getProviderNodes } from "@/lib/db/providers/nodes";
import { getPricingForModel } from "@/lib/db/settings/pricing";
import { saveCallLog } from "@/lib/usageDb";
import { attachOmniRouteMetaToResponse } from "@/domain/omnirouteResponseMeta";
import { createInjectionGuard } from "@/middleware/promptInjectionGuard";
import { randomUUID } from "node:crypto";
import { governedAttempt, governedAttemptResult } from "./context";

const prefixes: Record<string, string> = {
  "/v1/audio/speech": "local-tts/",
  "/v1/audio/transcriptions": "local-stt/",
  "/v1/images/generations": "local-image/",
  "/v1/images/edits": "local-image/",
  "/v1/embeddings": "local-embed/",
  "/v1/rerank": "local-rerank/",
};

export function usesMediaExecutor(path: string, model: string): boolean {
  return integratedMedia() && Boolean(prefixes[path]) && model.startsWith(prefixes[path]);
}

export async function prepareMediaExecution(
  key: { id: string; allowedConnections?: string[] },
  path: string,
  model: string
): Promise<string> {
  // The CP provider configuration is global. A connection-constrained key must never escape its pool.
  if (key.allowedConnections?.length)
    throw new TokenPolicyError("MEDIA_CONNECTION_SCOPE_UNSUPPORTED", 403);
  if (!prefixes[path] || !model.startsWith(prefixes[path]))
    throw new TokenPolicyError("MEDIA_ENDPOINT_MODEL_MISMATCH", 403);
  const revision = await mediaCatalogRevision();
  const owner = principalForKey(key.id);
  if (!owner?.active) throw new TokenPolicyError("PRINCIPAL_DISABLED", 403);
  // Repeat catalog validation using the exact configuration snapshot passed to the executor.
  const { publishedOffers } = await import("./offers");
  const assigned = JSON.parse(owner.offers_json) as { id: string; version: string }[];
  const current = await publishedOffers();
  if (
    assigned.find((o) => o.id === model)?.version !==
      current.find((o) => o.id === model)?.version ||
    revision !== (await mediaCatalogRevision())
  )
    throw new TokenPolicyError("OFFER_VERSION_CHANGED", 409);
  return revision;
}

export async function executeMedia(
  request: Request,
  path: string,
  model: string,
  receipt: string,
  revision: string,
  key: { id: string; name?: string | null }
): Promise<Response> {
  const start = Date.now();
  const headers = new Headers({
    Authorization: "Bearer " + (await mediaToken()),
    "X-BPbatam-Receipt": receipt,
    "X-BPbatam-Media-Revision": revision,
  });
  let payload: BodyInit;
  let characters = 0;
  if (request.headers.get("content-type")?.includes("application/json")) {
    const data = await request.json();
    const decision = createInjectionGuard()(data);
    if (decision.blocked)
      return Response.json(
        { error: { code: "SECURITY_001" } },
        { status: 400, headers: { "X-CP-Media-State": "rejected" } }
      );
    characters = typeof data.input === "string" ? data.input.length : 0;
    headers.set("Content-Type", "application/json");
    payload = JSON.stringify(data);
  } else {
    const form = await request.formData();
    const decision = createInjectionGuard()({ prompt: form.get("prompt") });
    if (decision.blocked)
      return Response.json(
        { error: { code: "SECURITY_001" } },
        { status: 400, headers: { "X-CP-Media-State": "rejected" } }
      );
    payload = form;
  }
  const [prefix, ...parts] = model.split("/");
  const provider = String(
    (await getProviderNodes()).find((node) => node.prefix === prefix)?.id ?? prefix
  );
  const localModel = parts.join("/");
  const attempt = governedAttempt(provider, localModel);
  let response: Response;
  try {
    response = await fetch(process.env.BPBATAM_MEDIA_EXECUTOR_URL + path, {
      method: "POST",
      headers,
      body: payload,
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(1300000)]),
      redirect: "error",
    });
    governedAttemptResult(attempt, provider, localModel, response.status);
  } catch (error) {
    governedAttemptResult(attempt, provider, localModel);
    throw error;
  }
  if (
    path === "/v1/embeddings" &&
    response.ok &&
    response.headers.get("X-CP-Media-State") === "completed"
  ) {
    const body = (await response.clone().json()) as {
      usage?: { prompt_tokens?: number; total_tokens?: number };
    };
    const usage = body.usage;
    if (usage && Number.isSafeInteger(usage.total_tokens) && Number(usage.total_tokens) >= 0) {
      const cost = await calculateCostDetailed(provider, localModel, usage);
      if (!cost.priced) recordUnpricedBudgetUsage(key.id, { provider, model: localModel });
      recordModalCallCost(key.id, { provider, model: localModel, costUsd: cost.costUsd });
      response = attachOmniRouteMetaToResponse(response, {
        provider,
        model: localModel,
        usage,
        costUsd: cost.costUsd,
        latencyMs: Date.now() - start,
        requestId: randomUUID(),
      });
    }
  }
  if (
    path !== "/v1/embeddings" &&
    path !== "/v1/rerank" &&
    response.ok &&
    response.headers.get("X-CP-Media-State") === "completed"
  ) {
    const transcription = path.includes("transcriptions");
    const seconds = Number(response.headers.get("X-CP-Media-Audio-Seconds") ?? 0);
    const dimensions = path.includes("images")
      ? ["output_cost_per_image", "input_cost_per_image"]
      : transcription
        ? ["input_cost_per_second", "output_cost_per_second"]
        : ["input_cost_per_character", "output_cost_per_character"];
    const pricing = (await getPricingForModel(provider, localModel)) as Record<
      string,
      unknown
    > | null;
    const priced =
      pricing &&
      dimensions.some(
        (d) =>
          typeof pricing[d] === "number" && Number.isFinite(pricing[d]) && Number(pricing[d]) >= 0
      ) &&
      (!transcription || (Number.isFinite(seconds) && seconds > 0));
    const costUsd = await calculateModalCost(
      path.includes("images") ? "image" : "audio",
      provider,
      localModel,
      path.includes("images") ? { n: 1 } : transcription ? { seconds } : { characters }
    );
    if (!priced) recordUnpricedBudgetUsage(key.id, { provider, model: localModel });
    recordModalCallCost(key.id, { provider, model: localModel, costUsd });
    response = attachOmniRouteMetaToResponse(response, {
      provider,
      model: localModel,
      costUsd,
      latencyMs: Date.now() - start,
      requestId: randomUUID(),
    });
  }
  if (path === "/v1/rerank" && response.ok) {
    recordUnpricedBudgetUsage(key.id, { provider, model: localModel });
    response = attachOmniRouteMetaToResponse(response, {
      provider,
      model: localModel,
      latencyMs: Date.now() - start,
      requestId: randomUUID(),
    });
  }
  await saveCallLog({
    method: "POST",
    path,
    status: response.status,
    provider,
    model,
    apiKeyId: key.id,
    apiKeyName: key.name ?? undefined,
    duration: Date.now() - start,
    ...(response.ok ? {} : { error: "MEDIA_EXECUTOR_REJECTED" }),
  }).catch(() => {});
  return response;
}
