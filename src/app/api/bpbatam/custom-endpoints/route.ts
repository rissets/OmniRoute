import { bridgeIdentity, bridgeRoles } from "@/lib/bpbatam/auth";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { getCustomEndpoints, createCustomEndpoint } from "@/lib/db/bpbatamCustomEndpoints";
import { z } from "zod";

const createEndpointSchema = z.object({
  name: z.string().trim().min(1).max(100),
  base_url: z.string().trim().min(1).max(2048),
  enabled: z.boolean().optional(),
  api_key: z.string().optional().nullable(),
});

export async function GET(request: Request) {
  const identity = await bridgeIdentity(request);
  if (!identity) return errorResponse(401, "BRIDGE_AUTH_REQUIRED");
  const roles = bridgeRoles(identity);
  const has = (r: string) => roles.includes("bp:" + r);
  if (!has("config.manage") && !has("read") && !has("root")) {
    return errorResponse(403, "BRIDGE_SCOPE_DENIED");
  }

  const endpoints = getCustomEndpoints();
  return Response.json(endpoints, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  const identity = await bridgeIdentity(request);
  if (!identity) return errorResponse(401, "BRIDGE_AUTH_REQUIRED");
  const roles = bridgeRoles(identity);
  const has = (r: string) => roles.includes("bp:" + r);
  if (!has("config.manage") && !has("write") && !has("root")) {
    return errorResponse(403, "BRIDGE_SCOPE_DENIED");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "INVALID_JSON");
  }

  const parsed = createEndpointSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(400, "INVALID_ENDPOINT_PAYLOAD");
  }

  try {
    const created = createCustomEndpoint(parsed.data);
    return Response.json(created, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("METADATA_ADDRESS_DENIED") ||
      msg.includes("INVALID_URL") ||
      msg.includes("INVALID_PROTOCOL") ||
      msg.includes("EMBEDDED_CREDENTIALS_FORBIDDEN")
    ) {
      return errorResponse(422, msg);
    }
    return errorResponse(500, "ENDPOINT_CREATION_FAILED");
  }
}
