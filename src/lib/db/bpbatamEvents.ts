import { randomUUID } from "node:crypto";
import { getDbInstance } from "./core";

export function operationalEvents(after: number, limit: number, root: string) {
  const db = getDbInstance();
  const rows = db
    .prepare(
      "SELECT seq,event_id,kind,payload_json,created_at FROM bp_operational_events WHERE seq>? ORDER BY seq LIMIT ?"
    )
    .all(after, limit) as Array<{
    seq: number;
    event_id: string;
    kind: string;
    payload_json: string;
    created_at: string;
  }>;
  // This installation has one delegated root; payloads are fixed by SQL triggers, never raw provider logs.
  const accepted = rows.filter((row) => {
    const payload = JSON.parse(row.payload_json) as { account_id?: string };
    if (!payload.account_id) return false;
    return !!db
      .prepare(
        "WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT a.id FROM bp_token_accounts a JOIN tree ON a.parent_id=tree.id) SELECT 1 FROM tree WHERE id=?"
      )
      .get(root, payload.account_id);
  });
  const instance = db
    .prepare("SELECT value FROM bp_operational_metadata WHERE id='instance_id'")
    .get() as { value: string };
  return {
    version: 1,
    instance_id: instance.value,
    events: accepted.map((r) => ({
      id: r.event_id,
      sequence: r.seq,
      kind: r.kind,
      payload: {
        ...JSON.parse(r.payload_json),
        usage: safeUsage(JSON.parse(r.payload_json).usage),
      },
      created_at: r.created_at,
    })),
    next_cursor: String(rows.at(-1)?.seq ?? after),
  };
}

export function safeUsage(value: unknown): Record<string, number | string> {
  let source = value;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      return {};
    }
  }
  if (!source || typeof source !== "object") return {};
  const result: Record<string, number | string> = {};
  for (const field of [
    "input",
    "output",
    "total",
    "reasoning",
    "cached",
    "cacheWrite",
    "version",
  ]) {
    const n = (source as Record<string, unknown>)[field];
    if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) result[field] = n;
  }
  const seconds = (source as Record<string, unknown>).audio_seconds;
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 && seconds < 86400)
    result.audio_seconds = seconds;
  const safeReasons = new Set([
    "provider_usage_missing_or_estimated",
    "upstream_or_handler_failure",
    "media_execution_confirmation_missing",
    "provider_receipt_not_recorded",
    "stream_interrupted",
    "client_disconnect",
    "dispatch_interrupted",
    "user_window_receipt_exceeds_reservation",
  ]);
  const reason = (source as Record<string, unknown>).reason;
  if (typeof reason === "string" && safeReasons.has(reason)) result.reason = reason;
  const evidenceReference = (source as Record<string, unknown>).evidence_reference;
  if (
    typeof evidenceReference === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:/#-]{2,199}$/.test(evidenceReference)
  )
    result.evidence_reference = evidenceReference;
  if (
    ["router-media-token-equivalent", "provider-token", "not-dispatched"].includes(
      String((source as Record<string, unknown>).unit)
    )
  )
    result.unit = String((source as Record<string, unknown>).unit);
  return result;
}

export function deniedRequest(
  owner: { account_id: string; department_id: string | null; policy_revision: number },
  keyId: string,
  endpoint: string,
  model: string | null,
  code: string
): string {
  const id = randomUUID();
  const created = new Date().toISOString();
  const payload = {
    request_id: id,
    account_id: owner.account_id,
    key_id: keyId,
    department_id: owner.department_id,
    policy_revision: owner.policy_revision,
    endpoint,
    model:
      model && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(model) ? model : "invalid-or-missing",
    state: "denied",
    actual: 0,
    reserved: 0,
    occurred_at: created,
    usage: { input: 0, output: 0, total: 0, unit: "not-dispatched" },
    error_code: code,
  };
  getDbInstance()
    .prepare(
      "INSERT INTO bp_operational_events(event_id,kind,payload_json,created_at) VALUES(?,'request.denied',?,?)"
    )
    .run("denied:" + id, JSON.stringify(payload), created);
  return id;
}
