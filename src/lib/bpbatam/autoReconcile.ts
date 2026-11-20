import {
  admission,
  listUncertainAdmissions,
  recordReconcileAttempt,
  settle,
} from "@/lib/db/bpbatam";
import { validateCustomEndpointUrl } from "./customTransport";
import { formatCreditsFromMicro } from "./creditUnits";
import { resolveDigiRouteBaseUrl } from "./digiCreditSync";

export type AutoReconcileOutcome = "settled" | "released" | "keep_uncertain" | "skipped";

export interface AutoReconcileItemResult {
  receiptId: string;
  outcome: AutoReconcileOutcome;
  actualMicro?: number;
  reason?: string;
}

export interface AutoReconcilePassSummary {
  processed: number;
  settled: number;
  released: number;
  keptUncertain: number;
  skipped: number;
  results: AutoReconcileItemResult[];
}

export interface AutoReconcileOptions {
  digiRouteUrl?: string;
  apiKey?: string;
  fetchFn?: typeof fetch;
  minAgeMs?: number;
  limit?: number;
}

interface DigiReceiptResponse {
  id?: string;
  external_receipt_id?: string | null;
  state?: string;
  actual_micro?: number | null;
  usage?: Record<string, unknown>;
}

async function fetchDigiReceipt(
  baseUrl: string,
  lookupId: string,
  apiKey: string,
  fetchImpl: typeof fetch
): Promise<{ status: number; body: DigiReceiptResponse | null }> {
  const url = validateCustomEndpointUrl(
    `${baseUrl}/api/v1/digi-credit/receipts/${encodeURIComponent(lookupId)}`
  );
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetchImpl(url.toString(), {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  const body = response.ok
    ? ((await response.json().catch(() => null)) as DigiReceiptResponse | null)
    : null;
  return { status: response.status, body };
}

export async function reconcileUncertainReceipt(
  receiptId: string,
  options?: AutoReconcileOptions
): Promise<AutoReconcileItemResult> {
  const row = admission(receiptId);
  if (!row || row.state !== "uncertain") {
    return { receiptId, outcome: "skipped", reason: "not_uncertain" };
  }

  const minAgeMs = options?.minAgeMs ?? 0;
  if (minAgeMs > 0 && row.created_at) {
    const createdMs = Date.parse(row.created_at);
    if (Number.isFinite(createdMs) && Date.now() - createdMs < minAgeMs) {
      return { receiptId, outcome: "skipped", reason: "below_min_age" };
    }
  }

  const baseUrl = resolveDigiRouteBaseUrl(options?.digiRouteUrl);
  if (!baseUrl) {
    return { receiptId, outcome: "keep_uncertain", reason: "digi_route_unconfigured" };
  }

  const apiKey = (
    options?.apiKey ??
    process.env.DIGI_ROUTE_API_KEY ??
    process.env.BPBATAM_DIGI_API_KEY ??
    ""
  ).trim();
  const fetchImpl = options?.fetchFn ?? fetch;

  try {
    let lookup = await fetchDigiReceipt(baseUrl, row.id, apiKey, fetchImpl);
    if (lookup.status === 404 && row.digi_receipt_id) {
      lookup = await fetchDigiReceipt(baseUrl, row.digi_receipt_id, apiKey, fetchImpl);
    }

    if (lookup.status === 404) {
      settle(row.id, 0, {
        source: "digi-route-auto-reconcile",
        reason: "digi_route_receipt_not_found",
      });
      return { receiptId: row.id, outcome: "released", actualMicro: 0 };
    }

    if (lookup.status < 200 || lookup.status >= 300 || !lookup.body) {
      const reason = `digi_route_http_${lookup.status}`;
      recordReconcileAttempt(row.id, reason);
      return { receiptId: row.id, outcome: "keep_uncertain", reason };
    }

    const remote = lookup.body;
    if (remote.state === "settled") {
      const actualMicro = remote.actual_micro;
      if (
        typeof actualMicro !== "number" ||
        !Number.isSafeInteger(actualMicro) ||
        actualMicro < 0
      ) {
        const reason = "digi_route_invalid_actual_micro";
        recordReconcileAttempt(row.id, reason);
        return { receiptId: row.id, outcome: "keep_uncertain", reason };
      }

      const settleResult = settle(row.id, actualMicro, {
        source: "digi-route-auto-reconcile",
        digi_receipt_id: remote.id ?? row.digi_receipt_id ?? undefined,
        raw_tokens: remote.usage ?? {},
        actual_micro_credits: actualMicro,
        actual_credits: formatCreditsFromMicro(actualMicro),
      });

      if (settleResult === "uncertain") {
        recordReconcileAttempt(row.id, "overage_requires_topup");
        return {
          receiptId: row.id,
          outcome: "keep_uncertain",
          reason: "overage_requires_topup",
        };
      }

      return {
        receiptId: row.id,
        outcome: actualMicro === 0 ? "released" : "settled",
        actualMicro,
      };
    }

    const reason = `digi_route_state:${remote.state ?? "unknown"}`;
    recordReconcileAttempt(row.id, reason);
    return { receiptId: row.id, outcome: "keep_uncertain", reason };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "digi_route_reconcile_error";
    recordReconcileAttempt(row.id, reason);
    return { receiptId: row.id, outcome: "keep_uncertain", reason };
  }
}

export async function runAutoReconcilePass(
  options?: AutoReconcileOptions
): Promise<AutoReconcilePassSummary> {
  const candidates = listUncertainAdmissions(options?.limit ?? 50);
  const minAgeMs = options?.minAgeMs ?? 5_000;
  const results: AutoReconcileItemResult[] = [];
  let settled = 0;
  let released = 0;
  let keptUncertain = 0;
  let skipped = 0;

  for (const row of candidates) {
    const res = await reconcileUncertainReceipt(row.id, { ...options, minAgeMs });
    results.push(res);
    if (res.outcome === "settled") settled++;
    else if (res.outcome === "released") released++;
    else if (res.outcome === "keep_uncertain") keptUncertain++;
    else skipped++;
  }

  return {
    processed: results.length,
    settled,
    released,
    keptUncertain,
    skipped,
    results,
  };
}

let autoReconcileTimer: NodeJS.Timeout | null = null;
let autoReconcileInFlight = false;

export function initAutoReconcileWorker(intervalMs = 30_000): void {
  if (
    process.env.OMNIROUTE_DISABLE_BACKGROUND_SERVICES === "1" ||
    process.env.OMNIROUTE_DISABLE_BACKGROUND_SERVICES === "true"
  ) {
    return;
  }

  if (autoReconcileTimer) return;
  autoReconcileTimer = setInterval(() => {
    if (autoReconcileInFlight) return;
    autoReconcileInFlight = true;
    void runAutoReconcilePass()
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("[AutoReconcile] Error in scheduled pass:", msg);
      })
      .finally(() => {
        autoReconcileInFlight = false;
      });
  }, intervalMs);

  if (
    typeof autoReconcileTimer === "object" &&
    autoReconcileTimer &&
    "unref" in autoReconcileTimer
  ) {
    autoReconcileTimer.unref();
  }
}

export function stopAutoReconcileWorker(): void {
  if (autoReconcileTimer) {
    clearInterval(autoReconcileTimer);
    autoReconcileTimer = null;
  }
}
