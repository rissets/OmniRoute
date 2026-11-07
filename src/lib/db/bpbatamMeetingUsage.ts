import { getDbInstance } from "./core";
import { principal, within } from "./bpbatam";
import { safeUsage } from "./bpbatamEvents";

export interface MeetingUsageIdentity {
  subject: string;
  issuer: string;
  operation_id: string;
  attempt_id: string;
  receipt_id?: string | null;
}

/** Exact metadata projection only; never replay inference or reconstruct an accounting ledger. */
export function meetingUsage(identity: MeetingUsageIdentity, root: string) {
  const empty = {
    operation_id: identity.operation_id,
    attempt_id: identity.attempt_id,
    receipt_id: null,
    operation_kind: null,
    input_kind: null,
    status: "not_found",
    receipt_state: null,
    native_unit: null,
    native_reserved: null,
    native_actual: null,
    provider_input_tokens: null,
    provider_output_tokens: null,
  };
  const owner = principal(identity.subject);
  if (!owner || owner.issuer !== identity.issuer || !within(owner.account_id, root)) return empty;
  const row = getDbInstance()
    .prepare(
      "SELECT a.receipt_id,a.operation_kind,a.provenance_json,r.account_id,r.state,r.reserved,r.actual,r.usage_json FROM bp_meeting_attempts a JOIN bp_token_admissions r ON r.id=a.receipt_id WHERE a.subject=? AND a.operation_id=? AND a.attempt_id=?"
    )
    .get(identity.subject, identity.operation_id, identity.attempt_id) as
    | {
        receipt_id: string;
        operation_kind: string;
        provenance_json: string;
        account_id: string;
        state: string;
        reserved: number;
        actual: number | null;
        usage_json: string;
      }
    | undefined;
  if (
    !row ||
    !["stt", "completion", "tts", "diarization"].includes(row.operation_kind) ||
    row.account_id !== owner.account_id ||
    (identity.receipt_id != null && row.receipt_id !== identity.receipt_id)
  )
    return empty;
  const usage = safeUsage(row.usage_json);
  let provenance: { input_kind?: unknown };
  try {
    provenance = JSON.parse(row.provenance_json);
    if (!provenance || typeof provenance !== "object") return empty;
  } catch {
    // Stored JSON may contain private provenance; correlate without retaining its value or error.
    console.warn("[MEETING_USAGE] Stored provenance unavailable", {
      category: "invalid_provenance_json",
      operation_id: identity.operation_id,
      attempt_id: identity.attempt_id,
    });
    return empty;
  }
  if (
    row.operation_kind === "stt" &&
    provenance.input_kind != null &&
    provenance.input_kind !== "question"
  )
    return empty;
  const tokens = usage.unit === "provider-token";
  return {
    operation_id: identity.operation_id,
    attempt_id: identity.attempt_id,
    receipt_id: row.receipt_id,
    operation_kind: row.operation_kind,
    input_kind:
      row.operation_kind === "stt" && provenance.input_kind === "question" ? "question" : null,
    status: "available",
    receipt_state: ["reserved", "uncertain", "settled"].includes(row.state) ? row.state : null,
    native_unit: usage.unit ?? "router-reservation-unit",
    native_reserved: String(row.reserved),
    native_actual: row.actual == null ? null : String(row.actual),
    provider_input_tokens: tokens && usage.input != null ? String(usage.input) : null,
    provider_output_tokens: tokens && usage.output != null ? String(usage.output) : null,
  };
}
