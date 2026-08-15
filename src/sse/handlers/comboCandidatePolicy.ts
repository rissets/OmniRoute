type ApiKeyCandidatePolicy = {
  allowedModels?: string[] | null;
  allowedCombos?: string[] | null;
  disableNonPublicModels?: boolean;
} | null | undefined;

/** Keep explicitly granted combo internals dispatchable without widening raw-model access. */
export function shouldEnforceCandidateModelAllowlist(
  apiKeyInfo: ApiKeyCandidatePolicy,
  comboName: string | null | undefined,
): boolean {
  if (!apiKeyInfo) return false;
  const hasModelRestrictions =
    Boolean(apiKeyInfo.allowedModels?.length) || apiKeyInfo.disableNonPublicModels === true;
  if (!hasModelRestrictions) return false;
  const explicitlyGranted =
    typeof comboName === "string" &&
    comboName.length > 0 &&
    Array.isArray(apiKeyInfo.allowedCombos) &&
    apiKeyInfo.allowedCombos.includes(comboName);
  return !explicitlyGranted;
}
