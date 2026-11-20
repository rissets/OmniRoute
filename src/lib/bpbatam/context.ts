import { AsyncLocalStorage } from "node:async_hooks";
import {
  admission,
  settle,
  appendAttemptEvent,
  preparedInputEvent,
  ensureReservation,
  attachDigiReceiptId,
} from "@/lib/db/bpbatam";
import type { DigiModelCreditRate } from "@/lib/db/bpbatamDigiSync";
import { calculateSettlementMicroCredits } from "./digiCreditSync";
import { formatCreditsFromMicro } from "./creditUnits";
import { canonicalUsage } from "./usage";

export interface GovernedAdmissionOperation {
  id: string;
  failed: boolean;
  dispatched: boolean;
  attempts?: number;
  outputLimit?: number;
  targetModel?: string;
  unit?: "micro_credits" | "token";
  modelRate?: DigiModelCreditRate;
  digiCreditChargedMicro?: number | null;
  digiReceiptId?: string | null;
}

const runtime = globalThis as typeof globalThis & {
  __bpbatamAdmission?: AsyncLocalStorage<GovernedAdmissionOperation>;
};
export const admissionContext = (runtime.__bpbatamAdmission ??=
  new AsyncLocalStorage<GovernedAdmissionOperation>());

export function getGovernedUpstreamHeaders(): Record<string, string> {
  const operation = admissionContext.getStore();
  if (!operation?.id) return {};
  return {
    "X-BPRoute-Receipt-Id": operation.id,
  };
}

export function recordGovernedUpstreamHeaders(headers: Headers | null | undefined): void {
  if (!headers) return;
  const operation = admissionContext.getStore();
  if (!operation) return;

  const digiReceipt = headers.get("x-digiroute-receipt-id");
  if (digiReceipt && digiReceipt.trim()) {
    operation.digiReceiptId = digiReceipt.trim();
    try {
      attachDigiReceiptId(operation.id, operation.digiReceiptId);
    } catch {
      // Non-fatal if DB unavailable or closed
    }
  }

  const chargedRaw = headers.get("x-digiroute-credit-charged-micro");
  if (chargedRaw != null && chargedRaw.trim() !== "") {
    const parsed = Number(chargedRaw.trim());
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      operation.digiCreditChargedMicro = parsed;
    }
  }
}

/** Only trusted provider usage reaches this hook; client-visible fallback estimates cannot debit. */
export function recordGovernedUsage(usage: unknown): void {
  const operation = admissionContext.getStore();
  if (!operation) return;
  const id = operation.id;
  const row = admission(id);
  if (!row || row.state === "settled") return;

  const canonical = operation.failed ? null : canonicalUsage(usage);
  if (!canonical) {
    settle(id, null, { reason: "provider_usage_missing_or_estimated" });
    return;
  }

  const settlement = calculateSettlementMicroCredits({
    usage: canonical,
    rate: operation.modelRate,
    digiCreditChargedMicro: operation.digiCreditChargedMicro,
  });

  const isCreditUnit = settlement.unit === "micro_credits";
  settle(id, settlement.actual, {
    ...canonical,
    raw_tokens: canonical,
    unit: isCreditUnit ? "micro_credits" : canonical.unit,
    ...(operation.digiReceiptId ? { digi_receipt_id: operation.digiReceiptId } : {}),
    ...(isCreditUnit
      ? {
          actual_micro_credits: settlement.actual,
          actual_credits: formatCreditsFromMicro(settlement.actual),
        }
      : {}),
  });
}

export function holdUnsettled(id: string, reason: string): void {
  const row = admission(id);
  if (row && row.state === "reserved") settle(id, null, { reason });
}

export function recordGovernedFailure(): void {
  const operation = admissionContext.getStore();
  if (operation) operation.failed = true;
}

export function recordGovernedDispatch(): void {
  const operation = admissionContext.getStore();
  if (operation) operation.dispatched = true;
}

export function governedAttempt(provider: string, model: string): number | null {
  const op = admissionContext.getStore();
  if (!op) return null;
  op.dispatched = true;
  op.targetModel = `${provider}/${model}`;
  op.attempts = (op.attempts ?? 0) + 1;
  if (op.attempts > 1) op.failed = true; // Multiple billable attempts require an authoritative aggregate before release.
  appendAttemptEvent(op.id, "attempt.started", op.attempts, provider, model);
  return op.attempts;
}

export function governedAttemptResult(
  attempt: number | null,
  provider: string,
  model: string,
  status?: number
): void {
  const op = admissionContext.getStore();
  if (!op || attempt === null) return;
  appendAttemptEvent(
    op.id,
    status == null ? "attempt.failed" : "attempt.headers",
    attempt,
    provider,
    model,
    status
  );
}

export function withGovernedProviderInput<T>(body: unknown, execute: () => T): T {
  const operation = admissionContext.getStore();
  if (operation) {
    const record = (body ?? {}) as Record<string, unknown>;
    const bodyBytes = Buffer.byteLength(JSON.stringify(body));
    const output = Number(
      record.max_tokens ??
        record.max_completion_tokens ??
        record.max_output_tokens ??
        operation.outputLimit ??
        0
    );
    const outTokens = Number.isSafeInteger(output) && output > 0 ? output : 0;

    let bound: number;
    if (operation.unit === "micro_credits" && operation.modelRate) {
      const rate = operation.modelRate;
      const inputBytes = bodyBytes + 128;
      bound = Math.max(
        1,
        Math.ceil(
          (inputBytes / 1_000_000) * rate.input_micro_credits_per_1m +
            (outTokens / 1_000_000) * rate.output_micro_credits_per_1m
        ) + rate.request_fee_micro_credits
      );
    } else {
      bound = bodyBytes + 128 + outTokens;
    }

    ensureReservation(operation.id, bound);
    preparedInputEvent(
      operation.id,
      bodyBytes,
      Buffer.byteLength(JSON.stringify(record.messages ?? [])),
      Buffer.byteLength(JSON.stringify(record.tools ?? []))
    );
  }
  return execute();
}
