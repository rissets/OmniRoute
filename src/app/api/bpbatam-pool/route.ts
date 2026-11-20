import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { TokenPolicyError } from "@/lib/db/bpbatam";
import { poolStatus } from "@/lib/db/bpbatamQuotas";
import { listDigiModelCreditRates } from "@/lib/db/bpbatamDigiSync";
import { buildTopUpLandingUrl, pullDigiCreditBalance } from "@/lib/bpbatam/digiCreditSync";
import { z } from "zod";

export async function GET(request: Request) {
  const error = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (error) return error;
  return Response.json(
    {
      ...poolStatus("bpbatam"),
      manual_minting_disabled: true,
      topup_url: buildTopUpLandingUrl("bpbatam"),
      model_credit_rates: listDigiModelCreditRates(),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

function isAllowedSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const parsedUrl = new URL(request.url);
  if (origin === parsedUrl.origin) return true;
  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    request.headers.get("host")?.trim();
  if (!host) return false;
  const protoRaw =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    parsedUrl.protocol.replace(/:$/, "");
  const proto = protoRaw === "https" ? "https" : "http";
  return origin === `${proto}://${host}`;
}

export async function POST(request: Request) {
  const error = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (error) return error;
  if (!isAllowedSameOrigin(request))
    return Response.json({ code: "ORIGIN_DENIED" }, { status: 403 });

  const rawBody = await request.json().catch(() => null);
  if (
    rawBody &&
    typeof rawBody === "object" &&
    ("tokens" in rawBody ||
      (rawBody as Record<string, unknown>).mode === "set-total" ||
      (rawBody as Record<string, unknown>).mode === "add")
  ) {
    return Response.json(
      {
        code: "MANUAL_POOL_MINTING_DISABLED",
        error:
          "Manual pool minting is disabled on BP Route. Credits are synced exclusively from Digi Route.",
      },
      { status: 403, headers: { "Cache-Control": "no-store" } }
    );
  }

  const parsed = z
    .object({
      action: z.literal("pull-sync").optional(),
      mode: z.literal("pull-sync").optional(),
    })
    .strict()
    .refine((data) => data.action === "pull-sync" || data.mode === "pull-sync", {
      message: "pull-sync action required",
    })
    .safeParse(rawBody);

  if (!parsed.success) {
    return Response.json({ code: "INVALID_POOL_ACTION" }, { status: 422 });
  }

  try {
    const syncResult = await pullDigiCreditBalance("bpbatam");
    return Response.json(
      {
        ...syncResult,
        manual_minting_disabled: true,
        topup_url: buildTopUpLandingUrl("bpbatam"),
        model_credit_rates: listDigiModelCreditRates(),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return Response.json(
      { code: err instanceof TokenPolicyError ? err.code : "DIGI_ROUTE_SYNC_UNAVAILABLE" },
      { status: err instanceof TokenPolicyError ? err.status : 503 }
    );
  }
}
