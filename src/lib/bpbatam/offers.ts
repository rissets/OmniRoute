import { isDeepStrictEqual } from "node:util";
import { resolveComboConfig } from "@omniroute/open-sse/services/comboConfig.ts";
import { deniedRequest } from "@/lib/db/bpbatamEvents";
import { integratedMedia, mediaCatalogRevision, mediaSettings } from "./media";
import { normalizeModelEntry } from "@omniroute/open-sse/services/combo/targetSorters.ts";
import { getModelAliases } from "@/lib/db/models";
import { resolveNestedComboModels } from "@omniroute/open-sse/services/combo/comboStructure.ts";
import { createHash } from "node:crypto";
import { getCombos } from "@/lib/db/combos";
import { getProviderNodes } from "@/lib/db/providers/nodes";
import { getAllActiveSyncedModels } from "@/lib/db/models/activeSyncedCatalog";
import { getAllCustomModels } from "@/lib/db/models";
import { principal, principalForKey } from "@/lib/db/bpbatam";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";

export interface Offer {
  id: string;
  kind: "model" | "combo";
  version: string;
  targets: string[];
  capabilities?: string[];
}

function sameOfferScope(left: Offer, right: Offer): boolean {
  const sameStringList = (a: unknown, b: unknown): boolean =>
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((value, index) => typeof value === "string" && value === b[index]);

  return (
    left.id === right.id &&
    left.kind === right.kind &&
    sameStringList(left.targets, right.targets) &&
    sameStringList(left.capabilities ?? [], right.capabilities ?? [])
  );
}

export async function publishedOffers(): Promise<Offer[]> {
  const [combos, nodes, synced, custom, mediaRevision] = await Promise.all([
    getCombos(),
    getProviderNodes(),
    getAllActiveSyncedModels(),
    getAllCustomModels(),
    mediaCatalogRevision(),
  ]);
  const ids = new Set<string>();
  for (const [provider, models] of Object.entries(synced)) {
    const prefix = nodes.find((n) => n?.id === provider)?.prefix ?? provider;
    for (const model of models) ids.add(prefix + "/" + model.id);
  }
  for (const [provider, models] of Object.entries(custom)) {
    const prefix = nodes.find((n) => n?.id === provider)?.prefix ?? provider;
    if (Array.isArray(models))
      for (const model of models) {
        const id = typeof model === "string" ? model : model?.id;
        if (typeof id === "string") ids.add(prefix + "/" + id);
      }
  }
  const hash = (kind: Offer["kind"], id: string, targets: string[], capabilities: string[]) =>
    createHash("sha256")
      .update(JSON.stringify([kind, id, targets, capabilities]))
      .digest("hex");
  const aliases = await getModelAliases();
  const legacyMediaHash = (id: string) =>
    createHash("sha256")
      .update(JSON.stringify([[id, mediaRevision], aliases]))
      .digest("hex");
  const modelOffers: Offer[] = [...ids].map((id) => {
    const capabilities = [
      id.includes("local-tts/")
        ? "tts"
        : id.includes("local-stt/")
          ? "transcribe"
          : id.includes("local-image/")
            ? "image"
            : id.includes("local-embed/")
              ? "embedding"
              : id.includes("local-rerank/")
                ? "rerank"
                : "chat",
    ];
    const targets = [id];
    const mediaModel =
      id.startsWith("local-tts/") ||
      id.startsWith("local-stt/") ||
      id.startsWith("local-image/") ||
      id.startsWith("local-embed/") ||
      id.startsWith("local-rerank/");
    return {
      id,
      kind: "model",
      version: mediaModel ? legacyMediaHash(id) : hash("model", id, targets, capabilities),
      targets,
      capabilities,
    };
  });
  const graph = combos.map((c) => ({
    name: String(c.name),
    models: Array.isArray(c.models) ? c.models : [],
  }));
  const defaultConfig = resolveComboConfig({}, {});
  const safeCombo = (name: string, seen = new Set<string>()): boolean => {
    if (seen.has(name) || seen.size >= 8) return false;
    const combo = combos.find((c) => c.name === name);
    if (!combo) return false;
    if (
      (combo.strategy ?? "priority") !== "priority" ||
      // The dashboard persists explicit defaults on new combos. Compare native
      // execution semantics, including opt-in flags, rather than rejecting every
      // nonempty config. Nondefault/unknown overrides still fail closed.
      !isDeepStrictEqual(resolveComboConfig(combo, {}), defaultConfig)
    )
      return false;
    const next = new Set(seen);
    next.add(name);
    return (Array.isArray(combo.models) ? combo.models : []).every((entry) => {
      const model = normalizeModelEntry(entry).model;
      return combos.some((c) => c.name === model) ? safeCombo(model, next) : ids.has(model);
    });
  };
  const comboOffers: Offer[] = combos
    .filter((combo) => safeCombo(String(combo.name)))
    .map((combo) => {
      const id = String(combo.name);
      const targets = resolveNestedComboModels(
        { name: String(combo.name), models: Array.isArray(combo.models) ? combo.models : [] },
        graph
      );
      const capabilities = ["chat"];
      return {
        id,
        kind: "combo" as const,
        capabilities,
        version: hash("combo", id, targets, capabilities),
        targets,
      };
    });
  return [
    ...modelOffers,
    ...comboOffers.filter(
      (offer) => offer.targets.length > 0 && offer.targets.every((id) => ids.has(id))
    ),
  ];
}
const mediaRoutes: Record<string, { kind: string; prefix: string; capability: string }> = {
  "/v1/audio/speech": { kind: "tts", prefix: "local-tts/", capability: "tts" },
  "/v1/audio/transcriptions": { kind: "stt", prefix: "local-stt/", capability: "transcribe" },
  "/v1/images/generations": { kind: "generate", prefix: "local-image/", capability: "image" },
  "/v1/images/edits": { kind: "edit", prefix: "local-image/", capability: "image" },
  "/v1/embeddings": { kind: "embeddings", prefix: "local-embed/", capability: "embedding" },
  "/v1/rerank": { kind: "rerank", prefix: "local-rerank/", capability: "rerank" },
};

export async function availableMediaOffers(path?: string): Promise<Offer[]> {
  if (!integratedMedia()) return [];
  const settings = await mediaSettings();
  const catalog = await publishedOffers();
  if (settings.revision !== (await mediaCatalogRevision()))
    throw new Error("MEDIA_CONFIGURATION_CHANGED");
  const routes = path ? [mediaRoutes[path]].filter(Boolean) : Object.values(mediaRoutes);
  return catalog.filter(
    (offer) =>
      offer.kind === "model" &&
      offer.targets.length === 1 &&
      offer.targets[0] === offer.id &&
      routes.some(
        (route) =>
          settings.effective?.[route.kind]?.key_configured === true &&
          typeof settings.effective?.[route.kind]?.model === "string" &&
          settings.effective[route.kind].model.length > 0 &&
          offer.id.startsWith(route.prefix) &&
          offer.capabilities?.includes(route.capability)
      )
  );
}

export async function projectedPrimaryMediaAccess(
  key: {
    id: string;
    modelAccessMode?: string;
    allowedModels?: string[];
    allowedCombos?: string[];
    blockedModels?: string[];
    allowedQuotas?: string[];
    disableNonPublicModels?: boolean;
    catalogScope?: string;
    forcedModel?: string | null;
  },
  path: string,
  model: string
): Promise<boolean> {
  const owner = principalForKey(key.id);
  if (
    !owner?.active ||
    principal(owner.subject)?.key_id !== key.id ||
    key.modelAccessMode !== "restricted" ||
    key.blockedModels?.length ||
    key.allowedQuotas?.length ||
    key.disableNonPublicModels ||
    (key.catalogScope && key.catalogScope !== "all") ||
    key.forcedModel ||
    !key.allowedModels ||
    !key.allowedCombos
  )
    return false;
  const assigned = JSON.parse(owner.offers_json) as Offer[];
  const same = (a: string[], b: string[]) =>
    a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
  if (
    !same(
      key.allowedModels,
      assigned.filter((o) => o.kind === "model").map((o) => o.id)
    ) ||
    !same(
      key.allowedCombos,
      assigned.filter((o) => o.kind === "combo").map((o) => o.id)
    )
  )
    return false;
  const normalized = path.replace(/^\/api\/v1/, "/v1");
  if (!mediaRoutes[normalized]) return false;
  return (await availableMediaOffers(normalized)).some((offer) => offer.id === model);
}

export async function managedPolicy(
  keyId: string,
  pathname: string,
  model: string | null
): Promise<Response | null> {
  const owner = principalForKey(keyId);
  if (!owner) return null;
  const deny = (status: number, code: string): Response => {
    const requestId = deniedRequest(owner, keyId, pathname, model, code);
    const response = errorResponse(status, code);
    response.headers.set("X-BPbatam-Request", requestId);
    return response;
  };
  if (!owner.active) return deny(403, "PRINCIPAL_DISABLED");
  const path = pathname.replace(/^\/api\/v1/, "/v1");
  const covered = [
    "/v1/models",
    "/v1/chat/completions",
    "/v1/audio/speech",
    "/v1/audio/transcriptions",
    "/v1/audio/diarizations",
    "/v1/images/generations",
    "/v1/images/edits",
    "/v1/embeddings",
    "/v1/rerank",
  ];
  if (!covered.includes(path)) return deny(403, "MANAGED_ENDPOINT_NOT_ADMITTED");
  if (path === "/v1/models") return null;
  if (mediaRoutes[path] && integratedMedia()) {
    const available = await availableMediaOffers(path);
    return model && available.some((offer) => offer.id === model)
      ? null
      : deny(403, "MODEL_NOT_ASSIGNED");
  }
  const assigned = JSON.parse(owner.offers_json) as Offer[];
  if (!model || !assigned.some((x) => x.id === model)) return deny(403, "MODEL_NOT_ASSIGNED");
  const current = await publishedOffers();
  const expected = assigned.find((x) => x.id === model)!;
  const live = current.find((x) => x.id === model);
  // Offer versions also change for catalog metadata and alias churn. Enforce the
  // assigned execution scope directly so unrelated catalog edits do not lock
  // out users; changed or removed targets still fail closed.
  if (!live || !sameOfferScope(expected, live)) return deny(409, "OFFER_VERSION_CHANGED");
  return null;
}

export async function managedResolvedAllowed(
  keyId: string,
  target: string
): Promise<boolean | null> {
  const owner = principalForKey(keyId);
  if (!owner) return null;
  if (!owner.active) return false;
  const nodes = await getProviderNodes();
  const normalize = (id: string) => {
    const slash = id.indexOf("/");
    if (slash < 1) return id;
    const provider = id.slice(0, slash);
    const node = nodes.find((n) => n && (n.id === provider || n.prefix === provider));
    return (node?.prefix ?? provider) + id.slice(slash);
  };
  const offers = JSON.parse(owner.offers_json) as Offer[];
  return offers.some((offer) => offer.targets.some((id) => normalize(id) === normalize(target)));
}
