import { getDbInstance } from "./core";
import { account, principal, TokenPolicyError } from "./bpbatam";
import { userLimits } from "./bpbatamQuotas";
import { clearApiKeyCaches } from "./apiKeys";

export function ownedSelfKey(subject: string, key: string) {
  selfPrincipal(subject);
  const row = getDbInstance()
    .prepare(
      "SELECT key_id FROM bp_subject_keys WHERE subject=? AND key_id=? AND purpose='api' AND revoked_at IS NULL"
    )
    .get(subject, key) as { key_id: string } | undefined;
  if (!row) throw new TokenPolicyError("SUBJECT_KEY_NOT_FOUND", 404);
  return row;
}
export function renameSelfKey(subject: string, key: string, name: string) {
  return getDbInstance().transaction(() => {
    ownedSelfKey(subject, key);
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 100) throw new TokenPolicyError("INVALID_KEY_NAME", 422);
    getDbInstance().prepare("UPDATE bp_subject_keys SET name=? WHERE key_id=?").run(trimmed, key);
    getDbInstance().prepare("UPDATE api_keys SET name=? WHERE id=?").run(trimmed, key);
    clearApiKeyCaches();
    return { key_id: key, name: trimmed };
  })();
}

export function selfPrincipal(subject: string) {
  const person = principal(subject);
  if (!person || !person.active) throw new TokenPolicyError("PRINCIPAL_DISABLED", 403);
  return person;
}
export function followParentKey(key: string) {
  getDbInstance().prepare("UPDATE bp_subject_keys SET follow_parent=1 WHERE key_id=?").run(key);
}
export function followingKeys(subject: string): { key_id: string }[] {
  return getDbInstance()
    .prepare(
      "SELECT key_id FROM bp_subject_keys WHERE subject=? AND follow_parent=1 AND revoked_at IS NULL AND purpose='api'"
    )
    .all(subject) as { key_id: string }[];
}
export function selfKeys(subject: string) {
  const person = selfPrincipal(subject);
  return getDbInstance()
    .prepare(
      `SELECT k.key_id,k.name,k.created_at,a.key_prefix,
    COUNT(r.id) AS requests,COALESCE(SUM(r.actual),0) AS tokens
    FROM bp_subject_keys k JOIN api_keys a ON a.id=k.key_id
    LEFT JOIN bp_token_admissions r ON r.key_id=k.key_id AND r.account_id=? AND r.state='settled'
    WHERE k.subject=? AND k.purpose='api' AND k.revoked_at IS NULL
    GROUP BY k.key_id ORDER BY k.created_at DESC`
    )
    .all(person.account_id, subject);
}
export function selfAccount(subject: string) {
  const person = selfPrincipal(subject);
  const wallet = account(person.account_id)!;
  const totals = getDbInstance()
    .prepare(
      `SELECT COUNT(*) AS requests,
    COALESCE(SUM(CASE WHEN state='settled' THEN actual ELSE 0 END),0) AS tokens,
    SUM(CASE WHEN state='settled' THEN 1 ELSE 0 END) AS settled,
    SUM(CASE WHEN state='uncertain' THEN 1 ELSE 0 END) AS uncertain,
    SUM(CASE WHEN state='reserved' THEN 1 ELSE 0 END) AS pending
    FROM bp_token_admissions WHERE account_id=?`
    )
    .get(wallet.id);
  const models = getDbInstance()
    .prepare(
      `SELECT model,COUNT(*) AS requests,COALESCE(SUM(actual),0) AS tokens
    FROM bp_token_admissions WHERE account_id=? AND state='settled' GROUP BY model ORDER BY tokens DESC`
    )
    .all(wallet.id);
  return {
    subject: person.subject,
    issuer: person.issuer,
    wallet: {
      balance: String(wallet.balance),
      reserved: String(wallet.reserved),
      available: String(wallet.balance - wallet.reserved),
    },
    limits: userLimits(wallet.id),
    totals,
    models,
    offers: (JSON.parse(person.offers_json) as { id: string; capabilities?: string[] }[]).map(
      (o) => ({ id: o.id, capabilities: o.capabilities ?? [] })
    ),
  };
}
