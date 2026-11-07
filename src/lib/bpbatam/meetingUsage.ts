import { z } from "zod";
import { bridgeIdentity, bridgeRoles } from "./auth";
import { meetingUsage } from "@/lib/db/bpbatamMeetingUsage";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { readRequestBodyWithLimit } from "@/shared/middleware/bodySizeGuard";

const input = z
  .object({
    attempts: z
      .array(
        z
          .object({
            subject: z.string().min(1).max(128),
            issuer: z.string().url().max(500),
            operation_id: z.string().uuid(),
            attempt_id: z.string().uuid(),
            receipt_id: z.string().min(1).max(200).nullable().optional(),
          })
          .strict()
      )
      .min(1)
      .max(100),
  })
  .strict();

export async function readMeetingUsage(request: Request): Promise<Response> {
  const identity = await bridgeIdentity(request);
  if (!identity) return errorResponse(401, "BRIDGE_AUTH_REQUIRED");
  if (
    identity.azp !==
      (process.env.BPBATAM_MEETING_EXECUTOR_CLIENT_ID ?? "bpbatam-control-plane-service") ||
    !bridgeRoles(identity).includes("bp:read")
  )
    return errorResponse(403, "MEETING_USAGE_SCOPE_REQUIRED");
  try {
    const parsed = input.safeParse(
      JSON.parse(new TextDecoder().decode(await readRequestBodyWithLimit(request, 100_000)))
    );
    if (!parsed.success) return errorResponse(422, "INVALID_MEETING_USAGE_QUERY");
    return Response.json(
      {
        attempts: parsed.data.attempts.map((attempt) =>
          meetingUsage(attempt, process.env.BPBATAM_CP_ACCOUNT ?? "bpbatam")
        ),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    // Caller input and storage errors may contain meeting content; retain only this category.
    console.warn("[MEETING_USAGE] Query unavailable", { category: "usage_query_failed" });
    return errorResponse(503, "MEETING_USAGE_UNAVAILABLE");
  }
}
