import { z } from "zod";
import { TokenPolicyError } from "@/lib/db/bpbatam";
import { applySignedDigiCreditSync } from "@/lib/bpbatam/digiCreditSync";

const rateSchema = z.object({
  model_id: z.string().min(1).max(200),
  input_micro_credits_per_1m: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  cached_micro_credits_per_1m: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  output_micro_credits_per_1m: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  unit_micro_credits: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  request_fee_micro_credits: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  billing_unit: z.string().min(1).max(64).optional(),
});

const digiCreditSyncSchema = z
  .object({
    command_id: z.string().min(1).max(200),
    tenant_id: z.string().min(1).max(128),
    order_id: z.string().max(128).optional(),
    mode: z.enum(["add", "sync"]),
    credits_granted: z.string().min(1).max(64).optional(),
    credits_granted_micro: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    economic_snapshot: z
      .object({
        base_credit_rupiah: z.number().int().positive().optional(),
        usd_idr_rate: z.number().positive().optional(),
        ref_tokens_per_credit: z.number().int().positive().optional(),
        revision: z.number().int().positive().optional(),
      })
      .optional(),
    model_credit_rates: z.array(rateSchema).max(500).optional(),
    issued_at: z.string().min(1).max(64),
    signature: z.string().min(1).max(256).optional(),
  })
  .strict();

export async function POST(request: Request) {
  let rawBody = "";
  let jsonBody: unknown = null;
  try {
    rawBody = await request.text();
    jsonBody = JSON.parse(rawBody);
  } catch {
    return Response.json({ code: "INVALID_JSON_BODY" }, { status: 400 });
  }

  const parsed = digiCreditSyncSchema.safeParse(jsonBody);
  if (!parsed.success) {
    return Response.json({ code: "INVALID_SYNC_PAYLOAD" }, { status: 422 });
  }

  const headerSig = request.headers.get("x-digiroute-signature");
  try {
    const result = applySignedDigiCreditSync(parsed.data, {
      rawSignature: headerSig,
      rawBody,
    });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json(
      { code: err instanceof TokenPolicyError ? err.code : "DIGI_CREDIT_SYNC_FAILED" },
      { status: err instanceof TokenPolicyError ? err.status : 503 }
    );
  }
}
