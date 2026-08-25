/**
 * Organization token reserve ledger.
 *
 * The monthly global token limit on the organization management key is the
 * source total.  This module only stores the operator-controlled commitment
 * breakdown for the current period (base user grants, shared grants, and
 * explicit reset grants).  A reset grant is a real debit: it consumes reserve
 * capacity and is idempotent by request key, so retries cannot double charge.
 */

import { randomUUID } from "crypto";
import { getDbInstance } from "./core";
import { listTokenLimits, upsertTokenLimit } from "./tokenLimits";

export type OrganizationReservePeriod = {
  apiKeyId: string;
  period: string;
  monthlyTokenLimit: number;
  baseUserTokens: number;
  sharedAllocatedTokens: number;
  resetDebits: number;
  committedTokens: number;
  shareableTokens: number;
  overcommitted: boolean;
  updatedAt: string | null;
};

export type ReserveConfigInput = {
  apiKeyId: string;
  period?: string;
  monthlyTokenLimit?: number;
  baseUserTokens?: number;
  sharedAllocatedTokens?: number;
};

export type ResetDebitInput = {
  apiKeyId: string;
  period?: string;
  subjectId: string;
  tokens: number;
  idempotencyKey: string;
  resetInterval: "5h" | "weekly";
  reason?: string;
  metadata?: Record<string, unknown>;
};

export class OrganizationReserveCapacityError extends Error {
  readonly availableTokens: number;

  constructor(message: string, availableTokens: number) {
    super(message);
    this.name = "OrganizationReserveCapacityError";
    this.availableTokens = availableTokens;
  }
}

function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

function normalizePeriod(value?: string): string {
  const period = (value || currentPeriod()).trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    throw new Error("period must use YYYY-MM format");
  }
  return period;
}

function nonNegativeInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return parsed;
}

function ensureSchema(): void {
  const db = getDbInstance();
  db.exec(`
    CREATE TABLE IF NOT EXISTS organization_reserve_periods (
      api_key_id TEXT NOT NULL,
      period TEXT NOT NULL,
      base_user_tokens INTEGER NOT NULL DEFAULT 0,
      shared_allocated_tokens INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (api_key_id, period)
    );
    CREATE TABLE IF NOT EXISTS organization_reserve_reset_debits (
      id TEXT PRIMARY KEY,
      api_key_id TEXT NOT NULL,
      period TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      tokens INTEGER NOT NULL CHECK (tokens > 0),
      idempotency_key TEXT NOT NULL UNIQUE,
      reason TEXT NOT NULL DEFAULT '',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_org_reserve_reset_key_period
      ON organization_reserve_reset_debits (api_key_id, period);
  `);
}

function monthlySourceLimit(apiKeyId: string): number {
  const limit = listTokenLimits(apiKeyId).find(
    (item) => item.scopeType === "global" && item.resetInterval === "monthly" && item.enabled
  );
  return Math.max(0, Number(limit?.tokenLimit || 0));
}

export function getOrganizationReserve(apiKeyId: string, period?: string): OrganizationReservePeriod {
  ensureSchema();
  const db = getDbInstance();
  const normalizedPeriod = normalizePeriod(period);
  const row = db
    .prepare(
      `SELECT base_user_tokens AS baseUserTokens,
              shared_allocated_tokens AS sharedAllocatedTokens,
              updated_at AS updatedAt
         FROM organization_reserve_periods
        WHERE api_key_id = ? AND period = ?`
    )
    .get(apiKeyId, normalizedPeriod) as Record<string, unknown> | undefined;
  const resetRow = db
    .prepare(
      `SELECT COALESCE(SUM(tokens), 0) AS resetDebits
         FROM organization_reserve_reset_debits
        WHERE api_key_id = ? AND period = ?`
    )
    .get(apiKeyId, normalizedPeriod) as Record<string, unknown> | undefined;
  const monthlyTokenLimit = monthlySourceLimit(apiKeyId);
  const baseUserTokens = Math.max(0, Number(row?.baseUserTokens || 0));
  const sharedAllocatedTokens = Math.max(0, Number(row?.sharedAllocatedTokens || 0));
  const resetDebits = Math.max(0, Number(resetRow?.resetDebits || 0));
  const committedTokens = baseUserTokens + sharedAllocatedTokens + resetDebits;
  return {
    apiKeyId,
    period: normalizedPeriod,
    monthlyTokenLimit,
    baseUserTokens,
    sharedAllocatedTokens,
    resetDebits,
    committedTokens,
    shareableTokens: Math.max(0, monthlyTokenLimit - committedTokens),
    overcommitted: committedTokens > monthlyTokenLimit,
    updatedAt: typeof row?.updatedAt === "string" ? row.updatedAt : null,
  };
}

export function setOrganizationReserve(input: ReserveConfigInput): OrganizationReservePeriod {
  ensureSchema();
  const db = getDbInstance();
  const period = normalizePeriod(input.period);
  // PUT is intentionally patch-like.  Updating only the platform total must
  // never erase commitments already reported by the operator dashboard.
  const currentReserve = getOrganizationReserve(input.apiKeyId, period);
  const baseUserTokens = nonNegativeInteger(
    input.baseUserTokens ?? currentReserve.baseUserTokens,
    "baseUserTokens"
  );
  const sharedAllocatedTokens = nonNegativeInteger(
    input.sharedAllocatedTokens ?? currentReserve.sharedAllocatedTokens,
    "sharedAllocatedTokens"
  );
  if (input.monthlyTokenLimit != null) {
    const monthlyTokenLimit = nonNegativeInteger(input.monthlyTokenLimit, "monthlyTokenLimit");
    if (monthlyTokenLimit <= 0) throw new Error("monthlyTokenLimit must be greater than zero");
    const current = listTokenLimits(input.apiKeyId).find(
      (item) => item.scopeType === "global" && item.resetInterval === "monthly"
    );
    const committedTokens = baseUserTokens + sharedAllocatedTokens + currentReserve.resetDebits;
    if (monthlyTokenLimit < committedTokens) {
      throw new OrganizationReserveCapacityError(
        `monthly platform budget cannot be below committed tokens; ${committedTokens} tokens are committed`,
        Math.max(0, committedTokens)
      );
    }
    upsertTokenLimit({
      id: current?.id,
      apiKeyId: input.apiKeyId,
      scopeType: "global",
      tokenLimit: monthlyTokenLimit,
      resetInterval: "monthly",
      resetTime: current?.resetTime,
      enabled: true,
    });
  }
  db.prepare(
    `INSERT INTO organization_reserve_periods
       (api_key_id, period, base_user_tokens, shared_allocated_tokens, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(api_key_id, period) DO UPDATE SET
       base_user_tokens = excluded.base_user_tokens,
       shared_allocated_tokens = excluded.shared_allocated_tokens,
       updated_at = datetime('now')`
  ).run(input.apiKeyId, period, baseUserTokens, sharedAllocatedTokens);
  return getOrganizationReserve(input.apiKeyId, period);
}

export function addOrganizationResetDebit(input: ResetDebitInput): {
  created: boolean;
  debitId: string;
  reserve: OrganizationReservePeriod;
} {
  ensureSchema();
  const db = getDbInstance();
  const period = normalizePeriod(input.period);
  const subjectId = input.subjectId.trim();
  const idempotencyKey = input.idempotencyKey.trim();
  if (input.resetInterval !== "5h" && input.resetInterval !== "weekly") {
    throw new Error("resetInterval must be 5h or weekly");
  }
  if (!subjectId) throw new Error("subjectId is required");
  if (!idempotencyKey) throw new Error("idempotencyKey is required");
  const tokens = nonNegativeInteger(input.tokens, "tokens");
  if (tokens <= 0) throw new Error("tokens must be greater than 0");
  const existing = db
    .prepare("SELECT id FROM organization_reserve_reset_debits WHERE idempotency_key = ?")
    .get(idempotencyKey) as Record<string, unknown> | undefined;
  if (existing?.id) {
    return {
      created: false,
      debitId: String(existing.id),
      reserve: getOrganizationReserve(input.apiKeyId, period),
    };
  }
  const before = getOrganizationReserve(input.apiKeyId, period);
  const available = before.shareableTokens;
  if (tokens > available) {
    throw new OrganizationReserveCapacityError(
      `reset grant exceeds organization reserve; ${available} tokens remain shareable`,
      available
    );
  }
  const debitId = randomUUID();
  db.prepare(
    `INSERT INTO organization_reserve_reset_debits
      (id, api_key_id, period, subject_id, tokens, idempotency_key, reason, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    debitId,
    input.apiKeyId,
    period,
    subjectId,
    tokens,
    idempotencyKey,
    input.reason || "user token reset grant",
    JSON.stringify(input.metadata || {})
  );
  return { created: true, debitId, reserve: getOrganizationReserve(input.apiKeyId, period) };
}
