export const MICRO_CREDITS_PER_CREDIT = 1_000_000;
export const DEFAULT_BASE_CREDIT_RUPIAH = 5000;
export const DEFAULT_USD_IDR_RATE = 18255;
export const DEFAULT_REF_TOKENS_PER_CREDIT = 152_200;

export function formatCreditsFromMicro(microCredits: number): string {
  const safe = Number.isFinite(microCredits) ? Math.trunc(microCredits) : 0;
  const sign = safe < 0 ? "-" : "";
  const abs = Math.abs(safe);
  const whole = Math.floor(abs / MICRO_CREDITS_PER_CREDIT);
  const frac = String(abs % MICRO_CREDITS_PER_CREDIT).padStart(6, "0");
  return `${sign}${whole}.${frac}`;
}

export function creditsToMicroCredits(credits: number | string): number {
  const numeric = typeof credits === "string" ? Number(credits) : credits;
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new Error("INVALID_CREDIT_AMOUNT");
  }
  const micro = Math.round(numeric * MICRO_CREDITS_PER_CREDIT);
  if (!Number.isSafeInteger(micro)) {
    throw new Error("CREDIT_AMOUNT_OVERFLOW");
  }
  return micro;
}

export function microCreditsToCredits(microCredits: number): number {
  if (!Number.isFinite(microCredits)) return 0;
  return microCredits / MICRO_CREDITS_PER_CREDIT;
}

export function microCreditsToEstimatedTokens(
  microCredits: number,
  refTokensPerCredit = DEFAULT_REF_TOKENS_PER_CREDIT
): number {
  if (!Number.isFinite(microCredits) || microCredits <= 0) return 0;
  const ref =
    Number.isFinite(refTokensPerCredit) && refTokensPerCredit > 0
      ? refTokensPerCredit
      : DEFAULT_REF_TOKENS_PER_CREDIT;
  return Math.round((microCredits / MICRO_CREDITS_PER_CREDIT) * ref);
}

export function estimatedTokensToMicroCredits(
  tokens: number,
  refTokensPerCredit = DEFAULT_REF_TOKENS_PER_CREDIT
): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  const ref =
    Number.isFinite(refTokensPerCredit) && refTokensPerCredit > 0
      ? refTokensPerCredit
      : DEFAULT_REF_TOKENS_PER_CREDIT;
  return Math.ceil((tokens / ref) * MICRO_CREDITS_PER_CREDIT);
}
