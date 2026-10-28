import { safeUsage } from "./bpbatamEvents";
import { createHash, randomUUID } from "node:crypto";
import { getDbInstance } from "./core";
import {
  checkPoolIngress,
  checkUserLimits,
  bindUserLimitAdmission,
  defaultUserLimits,
  poolCap,
} from "./bpbatamQuotas";

export class TokenPolicyError extends Error {
  constructor(
    public code: string,
    public status = 409
  ) {
    super(code);
  }
}
export interface TokenAccount {
  id: string;
  parent_id: string | null;
  kind: string;
  balance: number;
  reserved: number;
}
export interface Principal {
  subject: string;
  issuer: string;
  account_id: string;
  key_id: string;
  offers_json: string;
  active: number;
  department_id: string | null;
  policy_revision: number;
  desired_revision: number;
}
export interface Admission {
  id: string;
  key_id: string;
  account_id: string | null;
  reserved: number;
  actual: number | null;
  state: string;
  endpoint: string;
  model: string;
  limits_json: string;
  policy_revision: number | null;
  department_id: string | null;
}
export interface LimitSnapshot {
  id: string;
  window: string;
  limit: number;
  used: number;
}
const db = () => getDbInstance();
const stamp = () => new Date().toISOString();
export function account(id: string): TokenAccount | undefined {
  return db().prepare("SELECT * FROM bp_token_accounts WHERE id=?").get(id) as
    TokenAccount | undefined;
}
export function accounts(): TokenAccount[] {
  return db().prepare("SELECT * FROM bp_token_accounts ORDER BY id").all() as TokenAccount[];
}
export function within(id: string, root: string): boolean {
  return !!db()
    .prepare(
      "WITH RECURSIVE tree(id,parent_id) AS (SELECT id,parent_id FROM bp_token_accounts WHERE id=? UNION ALL SELECT a.id,a.parent_id FROM bp_token_accounts a JOIN tree ON a.id=tree.parent_id) SELECT 1 FROM tree WHERE id=?"
    )
    .get(id, root);
}
export function createAccount(id: string, parent: string | null, kind: string): TokenAccount {
  const prior = account(id);
  if (prior) {
    if (prior.parent_id !== parent || prior.kind !== kind)
      throw new TokenPolicyError("ACCOUNT_CONFLICT");
    return prior;
  }
  if (parent && !account(parent)) throw new TokenPolicyError("PARENT_NOT_FOUND", 404);
  db()
    .prepare("INSERT INTO bp_token_accounts(id,parent_id,kind) VALUES(?,?,?)")
    .run(id, parent, kind);
  return account(id)!;
}
function command(id: string, payload: unknown, actor: string): boolean {
  const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const prior = db().prepare("SELECT payload_hash FROM bp_token_commands WHERE id=?").get(id) as
    { payload_hash: string } | undefined;
  if (prior) {
    if (prior.payload_hash !== hash) throw new TokenPolicyError("IDEMPOTENCY_CONFLICT");
    return false;
  }
  db()
    .prepare("INSERT INTO bp_token_commands(id,payload_hash,actor) VALUES(?,?,?)")
    .run(id, hash, actor);
  return true;
}
function posting(id: string, source: string, target: string, amount: number, kind: string) {
  db()
    .prepare("INSERT INTO bp_token_postings VALUES(?,?,?,?,?),(?,?,?,?,?)")
    .run(id + ":out", id, source, -amount, kind, id + ":in", id, target, amount, kind);
}
export function allocate(
  id: string,
  source: string | null,
  target: string,
  amount: number,
  actor: string
): string {
  if (!Number.isSafeInteger(amount) || amount <= 0)
    throw new TokenPolicyError("INVALID_AMOUNT", 400);
  return db().transaction(() => {
    if (!command(id, ["allocate", source, target, amount], actor)) return "replayed";
    checkPoolIngress(source, target, amount);
    const destination = account(target);
    if (!destination) throw new TokenPolicyError("ACCOUNT_NOT_FOUND", 404);
    if (source === target || !Number.isSafeInteger(destination.balance + amount))
      throw new TokenPolicyError("INVALID_TRANSFER", 400);
    if (
      source &&
      !db()
        .prepare(
          "UPDATE bp_token_accounts SET balance=balance-? WHERE id=? AND balance-reserved>=?"
        )
        .run(amount, source, amount).changes
    )
      throw new TokenPolicyError("INSUFFICIENT_TOKENS", 429);
    db().prepare("UPDATE bp_token_accounts SET balance=balance+? WHERE id=?").run(amount, target);
    posting(id, source ?? "external-issuer", target, amount, source ? "transfer" : "grant");
    return "applied";
  })();
}
export function principal(subject: string): Principal | undefined {
  return db().prepare("SELECT * FROM bp_principals WHERE subject=?").get(subject) as
    Principal | undefined;
}
export function principalForKey(id: string): Principal | undefined {
  const direct = db().prepare("SELECT * FROM bp_principals WHERE key_id=?").get(id) as
    Principal | undefined;
  if (direct) return direct;
  return db()
    .prepare(
      "SELECT p.*,k.key_id,CASE WHEN k.revoked_at IS NULL THEN p.active ELSE 0 END AS active FROM bp_principals p JOIN bp_subject_keys k ON k.subject=p.subject WHERE k.key_id=?"
    )
    .get(id) as Principal | undefined;
}
export function bindPrincipal(
  subject: string,
  issuer: string,
  accountId: string,
  key: string
): Principal {
  const prior = principal(subject);
  if (prior) {
    if (prior.issuer !== issuer || prior.account_id !== accountId)
      throw new TokenPolicyError("SUBJECT_BINDING_CONFLICT");
    defaultUserLimits(accountId);
    return prior;
  }
  db()
    .prepare(
      "INSERT OR IGNORE INTO bp_principals(subject,issuer,account_id,key_id) VALUES(?,?,?,?)"
    )
    .run(subject, issuer, accountId, key);
  defaultUserLimits(accountId);
  return principal(subject)!;
}
export function setOffers(subject: string, offers: object[]): void {
  db()
    .prepare(
      "UPDATE bp_principals SET offers_json=?,policy_revision=policy_revision+1 WHERE subject=?"
    )
    .run(JSON.stringify(offers), subject);
}
export function setPrincipalActive(subject: string, active: boolean): void {
  db()
    .prepare("UPDATE bp_principals SET active=? WHERE subject=?")
    .run(active ? 1 : 0, subject);
}
export function rotatePrincipal(subject: string, key: string): void {
  db().prepare("UPDATE bp_principals SET key_id=? WHERE subject=?").run(key, subject);
}
export function admission(id: string): Admission | undefined {
  return db().prepare("SELECT * FROM bp_token_admissions WHERE id=?").get(id) as
    Admission | undefined;
}
export function reserve(
  id: string,
  key: string,
  amount: number,
  endpoint: string,
  model: string,
  limits: LimitSnapshot[],
  expectedPolicyRevision?: number
): Admission {
  if (!Number.isSafeInteger(amount) || amount <= 0)
    throw new TokenPolicyError("INVALID_RESERVATION", 400);
  return db().transaction(() => {
    if (admission(id)) throw new TokenPolicyError("DUPLICATE_INFERENCE", 409);
    const owner = principalForKey(key);
    if (owner && expectedPolicyRevision != null && owner.policy_revision !== expectedPolicyRevision)
      throw new TokenPolicyError("POLICY_CHANGED_RETRY", 409);
    if (owner && !owner.active) throw new TokenPolicyError("PRINCIPAL_DISABLED", 403);
    if (owner) checkUserLimits(owner.account_id, amount);
    if (
      owner &&
      db()
        .prepare(
          "SELECT 1 FROM bp_token_admissions WHERE account_id=? AND state='uncertain' LIMIT 1"
        )
        .get(owner.account_id)
    )
      throw new TokenPolicyError("ACCOUNT_RECONCILIATION_REQUIRED", 403);

    // Outstanding reservations survive process restarts; no timeout-based refund.
    const open = db()
      .prepare(
        "SELECT reserved,limits_json FROM bp_token_admissions WHERE key_id=? AND state IN ('reserved','uncertain')"
      )
      .all(key) as Array<{ reserved: number; limits_json: string }>;
    for (const limit of limits) {
      const held = open
        .filter((r) =>
          (JSON.parse(r.limits_json) as LimitSnapshot[]).some(
            (l) => l.id === limit.id && l.window === limit.window
          )
        )
        .reduce((s, r) => s + r.reserved, 0);
      if (limit.used + held + amount > limit.limit)
        throw new TokenPolicyError("TOKEN_RESERVATION_LIMIT", 429);
    }
    if (
      owner &&
      !db()
        .prepare(
          "UPDATE bp_token_accounts SET reserved=reserved+? WHERE id=? AND balance-reserved>=?"
        )
        .run(amount, owner.account_id, amount).changes
    )
      throw new TokenPolicyError("INSUFFICIENT_TOKENS", 429);
    db()
      .prepare(
        "INSERT INTO bp_token_admissions(id,key_id,account_id,reserved,state,endpoint,model,limits_json,department_id,policy_revision) VALUES(?,?,?,?,'reserved',?,?,?,?,?)"
      )
      .run(
        id,
        key,
        owner?.account_id ?? null,
        amount,
        endpoint,
        model,
        JSON.stringify(limits),
        owner?.department_id ?? null,
        owner?.policy_revision ?? null
      );
    if (owner) bindUserLimitAdmission(owner.account_id, id);
    return admission(id)!;
  })();
}
export function settle(id: string, actual: number | null, usage: object = {}): string {
  return db().transaction(() => {
    const row = admission(id);
    if (!row) throw new TokenPolicyError("RESERVATION_NOT_FOUND", 404);
    if (row.state === "settled") {
      if (row.actual !== actual) throw new TokenPolicyError("SETTLEMENT_CONFLICT");
      return "replayed";
    }
    if (actual === null || !Number.isSafeInteger(actual) || actual < 0) {
      db()
        .prepare(
          "UPDATE bp_token_admissions SET state='uncertain',usage_json=?,updated_at=? WHERE id=?"
        )
        .run(JSON.stringify(usage), stamp(), id);
      return "uncertain";
    }
    if (actual > row.reserved) {
      const extra = actual - row.reserved;
      if (row.account_id) {
        try {
          checkUserLimits(row.account_id, extra);
        } catch {
          db()
            .prepare(
              "UPDATE bp_token_admissions SET state='uncertain',usage_json=?,updated_at=? WHERE id=?"
            )
            .run(
              JSON.stringify({ ...usage, reason: "user_window_receipt_exceeds_reservation" }),
              stamp(),
              id
            );
          return "uncertain";
        }
      }
      if (
        !row.account_id ||
        !db()
          .prepare(
            "UPDATE bp_token_accounts SET reserved=reserved+? WHERE id=? AND balance-reserved>=?"
          )
          .run(extra, row.account_id, extra).changes
      ) {
        db()
          .prepare(
            "UPDATE bp_token_admissions SET state='uncertain',usage_json=?,updated_at=? WHERE id=?"
          )
          .run(JSON.stringify(usage), stamp(), id);
        return "uncertain";
      }
      db().prepare("UPDATE bp_token_admissions SET reserved=? WHERE id=?").run(actual, id);
      row.reserved = actual;
    }
    if (row.account_id) {
      db()
        .prepare("UPDATE bp_token_accounts SET balance=balance-?,reserved=reserved-? WHERE id=?")
        .run(actual, row.reserved, row.account_id);
      posting(id, row.account_id, "consumed-sink", actual, "consume");
    }
    db()
      .prepare(
        "UPDATE bp_token_admissions SET actual=?,state='settled',usage_json=?,updated_at=? WHERE id=?"
      )
      .run(actual, JSON.stringify(usage), stamp(), id);
    return "settled";
  })();
}
export function receipts(accountId?: string) {
  const rows = accountId
    ? db()
        .prepare(
          "SELECT id,account_id,endpoint,model,reserved,actual,state,usage_json,created_at FROM bp_token_admissions WHERE account_id=? ORDER BY created_at DESC LIMIT 200"
        )
        .all(accountId)
    : db()
        .prepare(
          "SELECT id,account_id,endpoint,model,reserved,actual,state,usage_json,created_at FROM bp_token_admissions ORDER BY created_at DESC LIMIT 200"
        )
        .all();
  return (
    rows as Array<{
      id: string;
      account_id: string;
      endpoint: string;
      model: string;
      reserved: number;
      actual: number | null;
      state: string;
      usage_json: string;
      created_at: string;
    }>
  ).map((r) => ({
    id: r.id,
    account_id: r.account_id,
    endpoint: r.endpoint,
    model: r.model,
    reserved: r.reserved,
    actual: r.actual,
    state: r.state,
    usage: safeUsage(r.usage_json),
    created_at: r.created_at,
  }));
}
export function journalBalance(): number {
  return (
    db().prepare("SELECT COALESCE(SUM(delta),0) AS total FROM bp_token_postings").get() as {
      total: number;
    }
  ).total;
}

export function reconcile(
  commandId: string,
  receipt: string,
  actual: number,
  actor: string,
  reason: string,
  evidenceReference: string
): string {
  return db().transaction(() => {
    if (!command(commandId, ["reconcile", receipt, actual, reason, evidenceReference], actor))
      return "replayed";
    const row = admission(receipt);
    if (!row || row.state !== "uncertain")
      throw new TokenPolicyError("UNCERTAIN_RECEIPT_REQUIRED", 409);
    if (actual > row.reserved) {
      const extra = actual - row.reserved;
      if (
        row.account_id &&
        !db()
          .prepare(
            "UPDATE bp_token_accounts SET reserved=reserved+? WHERE id=? AND balance-reserved>=?"
          )
          .run(extra, row.account_id, extra).changes
      )
        throw new TokenPolicyError("RECONCILIATION_TOPUP_REQUIRED", 429);
      db().prepare("UPDATE bp_token_admissions SET reserved=? WHERE id=?").run(actual, receipt);
    }
    return settle(receipt, actual, {
      source: "owner-attestation",
      reason,
      evidence_reference: evidenceReference,
      command_id: commandId,
    });
  })();
}

export function applyPolicy(
  subject: string,
  offers: object[],
  departmentId: string,
  revision: number,
  parent: string
): void {
  db().transaction(() => {
    const p = principal(subject);
    if (!p) throw new TokenPolicyError("PRINCIPAL_NOT_FOUND", 404);
    if (revision < p.desired_revision) throw new TokenPolicyError("POLICY_REVISION_STALE", 409);
    if (revision === p.desired_revision) {
      if (
        p.offers_json !== JSON.stringify(offers) ||
        p.department_id !== departmentId ||
        account(p.account_id)?.parent_id !== parent
      )
        throw new TokenPolicyError("POLICY_REVISION_CONFLICT", 409);
      return;
    }
    const destination = account(parent);
    if (!destination || destination.kind !== "department")
      throw new TokenPolicyError("DEPARTMENT_ACCOUNT_REQUIRED", 400);
    if (within(parent, p.account_id)) throw new TokenPolicyError("ACCOUNT_CYCLE", 400);
    db()
      .prepare("UPDATE bp_token_accounts SET parent_id=? WHERE id=? AND kind='user'")
      .run(parent, p.account_id);
    db()
      .prepare(
        "UPDATE bp_principals SET offers_json=?,department_id=?,desired_revision=?,policy_revision=policy_revision+1 WHERE subject=?"
      )
      .run(JSON.stringify(offers), departmentId, revision, subject);
  })();
}

export function subjectKeys(subject: string) {
  return db()
    .prepare(
      "SELECT key_id,name,created_at,revoked_at FROM bp_subject_keys WHERE subject=? AND purpose='api' ORDER BY created_at"
    )
    .all(subject);
}
export interface SubjectKeyCommand {
  key_id: string;
  subject: string;
  purpose: string;
  previous_key_id: string | null;
  revoked_at: string | null;
}
export function subjectKeyCommand(command: string): SubjectKeyCommand | undefined {
  return db()
    .prepare(
      "SELECT key_id,subject,purpose,previous_key_id,revoked_at FROM bp_subject_keys WHERE command_id=?"
    )
    .get(command) as SubjectKeyCommand | undefined;
}
export function bindSubjectKey(
  subject: string,
  key: string,
  command: string,
  name: string,
  purpose = "api",
  previous: string | null = null
) {
  db()
    .prepare(
      "INSERT INTO bp_subject_keys(key_id,subject,command_id,name,purpose,previous_key_id) VALUES(?,?,?,?,?,?)"
    )
    .run(key, subject, command, name, purpose, previous);
}
export function revokeSubjectKey(subject: string, key: string) {
  const result = db()
    .prepare(
      "UPDATE bp_subject_keys SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE subject=? AND key_id=? AND purpose='api'"
    )
    .run(subject, key);
  if (!result.changes) throw new TokenPolicyError("SUBJECT_KEY_NOT_FOUND", 404);
}
export function retirePrimaryKey(key: string): void {
  db()
    .prepare(
      "UPDATE bp_subject_keys SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE key_id=? AND purpose='lc-primary'"
    )
    .run(key);
}

export function principals(subject?: string): Principal[] {
  return subject
    ? (db().prepare("SELECT * FROM bp_principals WHERE subject=?").all(subject) as Principal[])
    : (db().prepare("SELECT * FROM bp_principals").all() as Principal[]);
}

export function topupRequests(): Array<{
  id: string;
  account_id: string;
  amount: number;
  status: string;
  actor: string;
  reason: string;
  created_at: string;
}> {
  return db()
    .prepare(
      "SELECT id,account_id,amount,status,actor,reason,created_at FROM bp_topup_requests ORDER BY created_at DESC"
    )
    .all() as Array<{
    id: string;
    account_id: string;
    amount: number;
    status: string;
    actor: string;
    reason: string;
    created_at: string;
  }>;
}
export function requestTopup(
  id: string,
  target: string,
  amount: number,
  actor: string,
  reason: string
) {
  const prior = db().prepare("SELECT * FROM bp_topup_requests WHERE id=?").get(id) as
    { account_id: string; amount: number; actor: string; reason: string } | undefined;
  if (prior) {
    if (
      prior.account_id !== target ||
      prior.amount !== amount ||
      prior.actor !== actor ||
      prior.reason !== reason
    )
      throw new TokenPolicyError("TOPUP_IDEMPOTENCY_CONFLICT", 409);
    return;
  }
  db()
    .prepare("INSERT INTO bp_topup_requests(id,account_id,amount,actor,reason) VALUES(?,?,?,?,?)")
    .run(id, target, amount, actor, reason);
}
export function decideTopup(id: string, approve: boolean, actor: string) {
  db().transaction(() => {
    const row = db().prepare("SELECT * FROM bp_topup_requests WHERE id=?").get(id) as
      { account_id: string; amount: number; status: string } | undefined;
    if (!row) throw new TokenPolicyError("TOPUP_NOT_FOUND", 404);
    const status = approve ? "issued" : "rejected";
    if (row.status === status) return;
    if (row.status !== "requested") throw new TokenPolicyError("TOPUP_STATE_CONFLICT", 409);
    if (approve) {
      const cap = poolCap(row.account_id);
      allocate(
        "topup:" + id,
        cap && row.account_id !== cap.account_id ? cap.account_id : null,
        row.account_id,
        row.amount,
        actor
      );
    }
    db()
      .prepare("UPDATE bp_topup_requests SET status=?,decided_by=? WHERE id=?")
      .run(status, actor, id);
  })();
}

export function mediaRevision(): string {
  const row = db()
    .prepare("SELECT value FROM bp_operational_metadata WHERE id='media_revision'")
    .get() as { value: string } | undefined;
  return row?.value ?? "0";
}
export function bumpMediaRevision(): void {
  db()
    .prepare(
      "INSERT INTO bp_operational_metadata(id,value) VALUES('media_revision','1') ON CONFLICT(id) DO UPDATE SET value=CAST(value AS INTEGER)+1"
    )
    .run();
}

export function placeAccount(id: string, parent: string | null, kind: string): TokenAccount {
  const existing = account(id);
  if (!existing) return createAccount(id, parent, kind);
  if (existing.kind !== kind) throw new TokenPolicyError("ACCOUNT_KIND_CONFLICT", 409);
  if (existing.parent_id === parent) return existing;
  if (kind === "platform" || !parent || !account(parent))
    throw new TokenPolicyError("ACCOUNT_PARENT_INVALID", 409);
  if (within(parent, id)) throw new TokenPolicyError("ACCOUNT_CYCLE", 409);
  db().prepare("UPDATE bp_token_accounts SET parent_id=? WHERE id=?").run(parent, id);
  return account(id)!;
}

export function appendAttemptEvent(
  receipt: string,
  kind: string,
  attempt: number,
  provider: string,
  model: string,
  status?: number
): void {
  const row = db()
    .prepare("SELECT account_id,department_id,policy_revision FROM bp_token_admissions WHERE id=?")
    .get(receipt) as
    | { account_id: string; department_id: string | null; policy_revision: number | null }
    | undefined;
  if (!row) return;
  db()
    .prepare("INSERT INTO bp_operational_events(event_id,kind,payload_json) VALUES(?,?,?)")
    .run(
      randomUUID(),
      kind,
      JSON.stringify({
        ...row,
        request_id: receipt,
        attempt,
        provider,
        model,
        ...(status != null ? { status } : {}),
      })
    );
}

export function preparedInputEvent(
  receipt: string,
  inputBytes: number,
  messageBytes: number,
  toolBytes: number
): void {
  const row = db()
    .prepare("SELECT account_id,department_id FROM bp_token_admissions WHERE id=?")
    .get(receipt) as { account_id: string; department_id: string | null } | undefined;
  if (row)
    db()
      .prepare("INSERT INTO bp_operational_events(event_id,kind,payload_json) VALUES(?,?,?)")
      .run(
        randomUUID(),
        "attempt.input-prepared",
        JSON.stringify({
          ...row,
          request_id: receipt,
          input_bytes: inputBytes,
          message_bytes: messageBytes,
          tool_bytes: toolBytes,
        })
      );
}

export function ensureReservation(receipt: string, bound: number): void {
  if (!Number.isSafeInteger(bound) || bound < 1)
    throw new TokenPolicyError("INVALID_RESERVATION", 400);
  db().transaction(() => {
    const row = admission(receipt);
    if (!row || row.state !== "reserved") throw new TokenPolicyError("RESERVATION_NOT_ACTIVE", 409);
    if (bound <= row.reserved) return;
    const extra = bound - row.reserved;
    if (row.account_id) checkUserLimits(row.account_id, extra);
    if (
      row.account_id &&
      !db()
        .prepare(
          "UPDATE bp_token_accounts SET reserved=reserved+? WHERE id=? AND balance-reserved>=?"
        )
        .run(extra, row.account_id, extra).changes
    )
      throw new TokenPolicyError("TOKEN_ALLOCATION_EXHAUSTED", 429);
    db().prepare("UPDATE bp_token_admissions SET reserved=? WHERE id=?").run(bound, receipt);
  })();
}

export function allocationReceipt(
  id: string
): Array<{ account_id: string; delta: number; kind: string }> {
  return db()
    .prepare("SELECT account_id,delta,kind FROM bp_token_postings WHERE command_id=? ORDER BY id")
    .all(id) as Array<{ account_id: string; delta: number; kind: string }>;
}
