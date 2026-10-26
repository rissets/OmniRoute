import { AsyncLocalStorage } from "node:async_hooks";
import {
  admission,
  settle,
  appendAttemptEvent,
  preparedInputEvent,
  ensureReservation,
} from "@/lib/db/bpbatam";
import { canonicalUsage } from "./usage";

const runtime = globalThis as typeof globalThis & {
  __bpbatamAdmission?: AsyncLocalStorage<{
    id: string;
    failed: boolean;
    dispatched: boolean;
    attempts?: number;
    outputLimit?: number;
  }>;
};
export const admissionContext = (runtime.__bpbatamAdmission ??= new AsyncLocalStorage<{
  id: string;
  failed: boolean;
  dispatched: boolean;
  attempts?: number;
  outputLimit?: number;
}>());
/** Only trusted provider usage reaches this hook; client-visible fallback estimates cannot debit. */
export function recordGovernedUsage(usage: unknown): void {
  const operation = admissionContext.getStore();
  if (!operation) return;
  const id = operation.id;
  const row = admission(id);
  if (!row || row.state === "settled") return;
  const canonical = operation.failed ? null : canonicalUsage(usage);
  settle(
    id,
    canonical?.total ?? null,
    canonical ?? { reason: "provider_usage_missing_or_estimated" }
  );
}
export function holdUnsettled(id: string, reason: string): void {
  const row = admission(id);
  if (row && row.state !== "settled") settle(id, null, { reason });
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
    const record = body as Record<string, unknown>;
    const output = Number(
      record.max_tokens ??
        record.max_completion_tokens ??
        record.max_output_tokens ??
        operation.outputLimit ??
        0
    );
    const bound =
      Buffer.byteLength(JSON.stringify(body)) +
      128 +
      (Number.isSafeInteger(output) && output > 0 ? output : 0);
    ensureReservation(operation.id, bound);
    preparedInputEvent(
      operation.id,
      Buffer.byteLength(JSON.stringify(body)),
      Buffer.byteLength(JSON.stringify(record.messages ?? [])),
      Buffer.byteLength(JSON.stringify(record.tools ?? []))
    );
  }
  return execute();
}
