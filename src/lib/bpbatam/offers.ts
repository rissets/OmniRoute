import { deniedRequest } from "@/lib/db/bpbatamEvents";
import { mediaCatalogRevision } from "./media";
import { normalizeModelEntry } from "@omniroute/open-sse/services/combo/targetSorters.ts";
import { getModelAliases } from "@/lib/db/models";
import { resolveNestedComboModels } from "@omniroute/open-sse/services/combo/comboStructure.ts";
import { createHash } from "node:crypto";
import { getCombos } from "@/lib/db/combos";
import { getProviderNodes } from "@/lib/db/providers/nodes";
import { getAllActiveSyncedModels } from "@/lib/db/models/activeSyncedCatalog";
import { getAllCustomModels } from "@/lib/db/models";
import { principalForKey } from "@/lib/db/bpbatam";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";

export interface Offer {
  id: string;
  kind: "model" | "combo";
  version: string;
  targets: string[];
  capabilities?: string[];
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
  const aliases = await getModelAliases();
  const hash = (x: unknown) =>
    createHash("sha256")
      .update(JSON.stringify([x, aliases]))
      .digest("hex");
  const modelOffers: Offer[] = [...ids].map((id) => ({
    id,
    kind: "model",
    version: hash(
      id.startsWith("local-tts/") || id.startsWith("local-stt/") || id.startsWith("local-image/")
        ? [id, mediaRevision]
        : id
    ),
    targets: [id],
    capabilities: [
      id.includes("local-tts/")
        ? "tts"
        : id.includes("local-stt/")
          ? "transcribe"
          : id.includes("local-image/")
            ? "image"
            : id.includes("local-embed/")
              ? "embedding"
              : "chat",
    ],
  }));
  const graph = combos.map((c) => ({
    name: String(c.name),
    models: Array.isArray(c.models) ? c.models : [],
  }));
  const safeCombo = (name: string, seen = new Set<string>()): boolean => {
    if (seen.has(name) || seen.size >= 8) return false;
    const combo = combos.find((c) => c.name === name);
    if (!combo) return false;
    if (
      (combo.strategy ?? "priority") !== "priority" ||
      (combo.config && Object.keys(combo.config as object).length)
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
    .map((combo) => ({
      id: String(combo.name),
      kind: "combo",
      capabilities: ["chat"],
      version: hash([
        combo,
        resolveNestedComboModels(
          { name: String(combo.name), models: Array.isArray(combo.models) ? combo.models : [] },
          graph
        ),
      ]),
      targets: resolveNestedComboModels(
        { name: String(combo.name), models: Array.isArray(combo.models) ? combo.models : [] },
        graph
      ),
    }));
  return [
    ...modelOffers,
    ...comboOffers.filter(
      (offer) => offer.targets.length > 0 && offer.targets.every((id) => ids.has(id))
    ),
  ];
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
    "/v1/images/generations",
    "/v1/images/edits",
    "/v1/embeddings",
  ];
  if (!covered.includes(path)) return deny(403, "MANAGED_ENDPOINT_NOT_ADMITTED");
  if (path === "/v1/models") return null;
  const assigned = JSON.parse(owner.offers_json) as Offer[];
  if (!model || !assigned.some((x) => x.id === model)) return deny(403, "MODEL_NOT_ASSIGNED");
  const current = await publishedOffers();
  const expected = assigned.find((x) => x.id === model)!;
  const live = current.find((x) => x.id === model);
  if (!live || live.version !== expected.version) return deny(409, "OFFER_VERSION_CHANGED");
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
