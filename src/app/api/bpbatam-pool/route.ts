import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { TokenPolicyError } from "@/lib/db/bpbatam";
import { poolStatus, configurePool } from "@/lib/db/bpbatamQuotas";
import { z } from "zod";

export async function GET(request: Request) {
  const error = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (error) return error;
  return Response.json(poolStatus("bpbatam"), { headers: { "Cache-Control": "no-store" } });
}
export async function POST(request: Request) {
  const error = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (error) return error;
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin)
    return Response.json({ code: "ORIGIN_DENIED" }, { status: 403 });
  const parsed = z
    .object({
      command_id: z.string().uuid(),
      mode: z.enum(["set-total", "add"]),
      tokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      expected_issued: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
    .strict()
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ code: "INVALID_POOL_AMOUNT" }, { status: 422 });
  try {
    const body = parsed.data;
    const result = configurePool(
      body.command_id,
      body.mode,
      body.tokens,
      body.expected_issued,
      "omniroute-dashboard-owner"
    );
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { code: error instanceof TokenPolicyError ? error.code : "POOL_UNAVAILABLE" },
      { status: error instanceof TokenPolicyError ? error.status : 503 }
    );
  }
}
