import { createHash } from "node:crypto";
import { getDbInstance } from "./core";
import { TokenPolicyError, allocate, account, createAccount } from "./bpbatam";

export const USER_WINDOWS = { "5h": 18000, "7d": 604800, "30d": 2592000 } as const;
type WindowName = keyof typeof USER_WINDOWS;
type WindowRow = { seconds: number; token_limit: number; anchor_ms: number; epoch: number };
const db = () => getDbInstance();
export function defaultUserLimits(account: string) {
  db().prepare("INSERT OR IGNORE INTO bp_user_quota_profiles(account_id) VALUES(?)").run(account);
  for (const [name, tokens] of Object.entries({ "5h": 1000000, "7d": 10000000, "30d": 30000000 }))
    db()
      .prepare(
        "INSERT OR IGNORE INTO bp_user_windows(account_id,seconds,token_limit,anchor_ms) VALUES(?,?,?,?)"
      )
      .run(account, USER_WINDOWS[name as WindowName], tokens, Date.now());
}
function usage(account: string, row: WindowRow, now = Date.now()) {
  const period = Math.max(0, Math.floor((now - row.anchor_ms) / (row.seconds * 1000)));
  const used = (
    db()
      .prepare(
        "SELECT COALESCE(SUM(a.actual),0) AS n FROM bp_user_window_admissions w JOIN bp_token_admissions a ON a.id=w.admission_id WHERE w.account_id=? AND w.seconds=? AND w.epoch=? AND w.period=? AND a.state='settled'"
      )
      .get(account, row.seconds, row.epoch, period) as { n: number }
  ).n;
  const held = (
    db()
      .prepare(
        "SELECT COALESCE(SUM(reserved),0) AS n FROM bp_token_admissions WHERE account_id=? AND state IN ('reserved','uncertain')"
      )
      .get(account) as { n: number }
  ).n;
  return {
    period,
    used,
    held,
    reset_at: new Date(row.anchor_ms + (period + 1) * row.seconds * 1000).toISOString(),
  };
}
export function userLimits(account: string) {
  const profile = db()
    .prepare("SELECT revision FROM bp_user_quota_profiles WHERE account_id=?")
    .get(account) as { revision: number } | undefined;
  const rows = db()
    .prepare("SELECT * FROM bp_user_windows WHERE account_id=? ORDER BY seconds")
    .all(account) as WindowRow[];
  return {
    revision: profile?.revision ?? 0,
    windows: rows.map((row) => {
      const u = usage(account, row);
      return {
        window: Object.entries(USER_WINDOWS).find(([, s]) => s === row.seconds)![0],
        limit: String(row.token_limit),
        used: String(u.used),
        reserved: String(u.held),
        available: String(Math.max(0, row.token_limit - u.used - u.held)),
        reset_at: u.reset_at,
      };
    }),
  };
}
export function checkUserLimits(account: string, amount: number) {
  for (const row of db()
    .prepare("SELECT * FROM bp_user_windows WHERE account_id=?")
    .all(account) as WindowRow[]) {
    const u = usage(account, row);
    if (u.used + u.held + amount > row.token_limit)
      throw new TokenPolicyError("USER_TOKEN_WINDOW_EXHAUSTED", 429);
  }
}
export function bindUserLimitAdmission(account: string, receipt: string) {
  for (const row of db()
    .prepare("SELECT * FROM bp_user_windows WHERE account_id=?")
    .all(account) as WindowRow[]) {
    const u = usage(account, row);
    db()
      .prepare("INSERT INTO bp_user_window_admissions VALUES(?,?,?,?,?)")
      .run(receipt, account, row.seconds, row.epoch, u.period);
  }
}
export function changeUserLimits(
  id: string,
  account: string,
  revision: number,
  body: { limits?: { window: WindowName; tokens: number }[]; reset?: WindowName[] }
) {
  return db().transaction(() => {
    const hash = createHash("sha256")
      .update(JSON.stringify([account, revision, body]))
      .digest("hex");
    const prior = db().prepare("SELECT * FROM bp_user_window_commands WHERE id=?").get(id) as
      { payload_hash: string; result_json: string } | undefined;
    if (prior) {
      if (prior.payload_hash !== hash) throw new TokenPolicyError("IDEMPOTENCY_CONFLICT");
      return JSON.parse(prior.result_json);
    }
    defaultUserLimits(account);
    if (userLimits(account).revision !== revision) throw new TokenPolicyError("REVISION_CONFLICT");
    if (
      body.reset?.length &&
      db()
        .prepare(
          "SELECT 1 FROM bp_token_admissions WHERE account_id=? AND state IN ('reserved','uncertain') LIMIT 1"
        )
        .get(account)
    )
      throw new TokenPolicyError("PENDING_RECEIPTS_PREVENT_LIMIT_RESET");
    for (const row of body.limits ?? [])
      db()
        .prepare("UPDATE bp_user_windows SET token_limit=? WHERE account_id=? AND seconds=?")
        .run(row.tokens, account, USER_WINDOWS[row.window]);
    for (const name of body.reset ?? [])
      db()
        .prepare(
          "UPDATE bp_user_windows SET anchor_ms=?,epoch=epoch+1 WHERE account_id=? AND seconds=?"
        )
        .run(Date.now(), account, USER_WINDOWS[name]);
    db()
      .prepare("UPDATE bp_user_quota_profiles SET revision=revision+1 WHERE account_id=?")
      .run(account);
    const result = userLimits(account);
    db()
      .prepare("INSERT INTO bp_user_window_commands VALUES(?,?,?)")
      .run(id, hash, JSON.stringify(result));
    return result;
  })();
}
export function poolCap(account: string): { account_id: string; ceiling: number } | undefined {
  return db()
    .prepare(
      "WITH RECURSIVE parents(id,parent_id) AS (SELECT id,parent_id FROM bp_token_accounts WHERE id=? UNION ALL SELECT a.id,a.parent_id FROM bp_token_accounts a JOIN parents p ON p.parent_id=a.id) SELECT c.* FROM bp_pool_caps c JOIN parents p ON p.id=c.account_id LIMIT 1"
    )
    .get(account) as { account_id: string; ceiling: number } | undefined;
}
export function poolStatus(root: string) {
  const value = db()
    .prepare(
      "WITH RECURSIVE tree(id) AS (SELECT id FROM bp_token_accounts WHERE id=? UNION ALL SELECT a.id FROM bp_token_accounts a JOIN tree t ON a.parent_id=t.id) SELECT COALESCE(SUM(p.delta),0) AS n FROM bp_token_postings p JOIN tree t ON t.id=p.account_id WHERE p.kind='grant' AND p.delta>0"
    )
    .get(root) as { n: number };
  const rows = db()
    .prepare(
      "WITH RECURSIVE tree(id) AS (SELECT id FROM bp_token_accounts WHERE id=? UNION ALL SELECT a.id FROM bp_token_accounts a JOIN tree t ON a.parent_id=t.id) SELECT a.* FROM bp_token_accounts a JOIN tree t ON t.id=a.id"
    )
    .all(root) as {
    id: string;
    parent_id: string | null;
    kind: string;
    balance: number;
    reserved: number;
  }[];
  return {
    account_id: root,
    ceiling: String(poolCap(root)?.ceiling ?? 0),
    issued: String(value.n),
    remaining: String(rows.reduce((s, a) => s + a.balance, 0)),
    reserved: String(rows.reduce((s, a) => s + a.reserved, 0)),
    consumed: String(value.n - rows.reduce((s, a) => s + a.balance, 0)),
    accounts: rows.map((a) => ({ ...a, balance: String(a.balance), reserved: String(a.reserved) })),
  };
}
export function setPoolCap(root: string, ceiling: number) {
  if (root !== "bpbatam" || !Number.isSafeInteger(ceiling) || ceiling <= 0)
    throw new TokenPolicyError("INVALID_POOL_CEILING", 422);
  if (Number(poolStatus(root).issued) > ceiling)
    throw new TokenPolicyError("POOL_ALREADY_EXCEEDS_CEILING");
  db()
    .prepare(
      "INSERT INTO bp_pool_caps VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET ceiling=excluded.ceiling"
    )
    .run(root, ceiling);
}
export function configurePool(
  id: string,
  mode: "set-total" | "add",
  tokens: number,
  expectedIssued: number,
  actor: string
) {
  return db().transaction(() => {
    if (!Number.isSafeInteger(tokens) || tokens <= 0 || !Number.isSafeInteger(expectedIssued))
      throw new TokenPolicyError("INVALID_POOL_AMOUNT", 422);
    const hash = createHash("sha256")
      .update(JSON.stringify([mode, tokens, expectedIssued]))
      .digest("hex");
    const previous = db().prepare("SELECT * FROM bp_pool_commands WHERE id=?").get(id) as
      { payload_hash: string; result_json: string } | undefined;
    if (previous) {
      if (previous.payload_hash !== hash) throw new TokenPolicyError("IDEMPOTENCY_CONFLICT");
      return JSON.parse(previous.result_json);
    }
    if (!account("bpbatam")) createAccount("bpbatam", null, "platform");
    const before = poolStatus("bpbatam");
    const issued = Number(before.issued);
    if (issued !== expectedIssued) throw new TokenPolicyError("POOL_REVISION_CONFLICT");
    const total = mode === "add" ? issued + tokens : tokens;
    if (!Number.isSafeInteger(total) || total < issued)
      throw new TokenPolicyError("POOL_BELOW_ALREADY_ISSUED", 422);
    setPoolCap("bpbatam", mode === "add" ? Math.max(Number(before.ceiling), total) : total);
    if (total > issued) allocate("pool:" + id, null, "bpbatam", total - issued, actor);
    const result = poolStatus("bpbatam");
    db()
      .prepare("INSERT INTO bp_pool_commands(id,payload_hash,result_json,actor) VALUES(?,?,?,?)")
      .run(id, hash, JSON.stringify(result), actor);
    return result;
  })();
}
export function checkPoolIngress(source: string | null, target: string, amount: number) {
  const dest = poolCap(target);
  const from = source ? poolCap(source) : undefined;
  if (source && dest?.account_id !== from?.account_id && (dest || from))
    throw new TokenPolicyError("CROSS_POOL_TRANSFER_DENIED", 403);
  if (!source && dest && Number(poolStatus(dest.account_id).issued) + amount > dest.ceiling)
    throw new TokenPolicyError("BPBATAM_POOL_ISSUANCE_EXHAUSTED", 429);
}
