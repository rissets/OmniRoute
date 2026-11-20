export const BP_ROUTE_PROVIDER_HARD_LOCK_ENV = "BP_ROUTE_PROVIDER_HARD_LOCK";
export const BP_ROUTE_PROVIDER_LOCKED_CODE = "BP_ROUTE_PROVIDER_LOCKED";
export const BP_ROUTE_PROVIDER_LOCKED_MESSAGE =
  "Built-in providers are disabled in BP Route. Only OpenAI-compatible and Anthropic-compatible custom endpoints connected to Digi Route are allowed.";

const OPENAI_COMPATIBLE_PREFIX = "openai-compatible-";
const ANTHROPIC_COMPATIBLE_PREFIX = "anthropic-compatible-";
const CLAUDE_CODE_COMPATIBLE_PREFIX = "anthropic-compatible-cc-";
const CUSTOM_ENDPOINT_ID_PREFIX = "ce_";

const DISABLED_FLAG_VALUES = new Set(["false", "0", "no", "off"]);

export type BpRouteProviderNodeLike = {
  id?: string | null;
  type?: string | null;
};

/**
 * BP Route hard-locks provider management to OpenAI-compatible and
 * Anthropic-compatible custom endpoints by default (spec: billing/docs.md §6.4.1).
 * Set BP_ROUTE_PROVIDER_HARD_LOCK=false only when running full upstream catalog mode.
 */
export function isBpRouteProviderHardLockEnabled(override?: boolean): boolean {
  if (typeof override === "boolean") return override;
  const raw =
    typeof process !== "undefined" && process.env
      ? (process.env[BP_ROUTE_PROVIDER_HARD_LOCK_ENV] ??
        process.env.NEXT_PUBLIC_BP_ROUTE_PROVIDER_HARD_LOCK)
      : undefined;
  if (typeof raw !== "string") return true;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return true;
  return !DISABLED_FLAG_VALUES.has(normalized);
}

export function isAllowedBpRouteProviderId(
  providerId: unknown,
  providerNode?: BpRouteProviderNodeLike | null
): boolean {
  if (typeof providerId !== "string" || providerId.length === 0) return false;
  if (providerId.startsWith(CLAUDE_CODE_COMPATIBLE_PREFIX)) return false;

  if (providerNode) {
    if (providerNode.type === "openai-compatible") return true;
    if (providerNode.type === "anthropic-compatible") return true;
    return false;
  }

  return (
    providerId.startsWith(OPENAI_COMPATIBLE_PREFIX) ||
    providerId.startsWith(ANTHROPIC_COMPATIBLE_PREFIX) ||
    providerId.startsWith(CUSTOM_ENDPOINT_ID_PREFIX)
  );
}

export function isAllowedBpRouteNodeType(
  nodeType: unknown,
  compatMode?: unknown,
  preset?: unknown
): boolean {
  if (preset === "vibeproxy-openai") return false;
  if (nodeType === "openai-compatible") return true;
  if (nodeType === "anthropic-compatible") {
    return compatMode !== "cc";
  }
  return false;
}
