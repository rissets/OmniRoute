import { bridgeIdentity, bridgeRoles } from "@/lib/bpbatam/auth";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import {
  getCustomEndpoint,
  updateCustomEndpoint,
  deleteCustomEndpoint,
  createCustomEndpointModel,
  updateCustomEndpointModel,
  deleteCustomEndpointModel,
  getDecryptedEndpointApiKey,
} from "@/lib/db/bpbatamCustomEndpoints";
import { testCustomEndpointModel } from "@/lib/bpbatam/customTransport";
import { z } from "zod";

type RouteContext = {
  params: Promise<{ slug: string[] }> | { slug: string[] };
};

const updateEndpointSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  base_url: z.string().trim().min(1).max(2048).optional(),
  enabled: z.boolean().optional(),
  api_key: z.string().optional().nullable(),
});

const createModelSchema = z.object({
  upstream_id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  enabled: z.boolean().optional(),
  quota_enabled: z.boolean().optional(),
});

const updateModelSchema = z.object({
  upstream_id: z.string().trim().min(1).max(200).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  quota_enabled: z.boolean().optional(),
});

async function authenticate(request: Request, writeAccess = false) {
  const identity = await bridgeIdentity(request);
  if (!identity) return { error: errorResponse(401, "BRIDGE_AUTH_REQUIRED") };
  const roles = bridgeRoles(identity);
  const has = (r: string) => roles.includes("bp:" + r);
  if (writeAccess) {
    if (!has("config.manage") && !has("write") && !has("root")) {
      return { error: errorResponse(403, "BRIDGE_SCOPE_DENIED") };
    }
  } else {
    if (!has("config.manage") && !has("read") && !has("root")) {
      return { error: errorResponse(403, "BRIDGE_SCOPE_DENIED") };
    }
  }
  return { identity };
}

export async function GET(request: Request, ctx: RouteContext) {
  const auth = await authenticate(request, false);
  if (auth.error) return auth.error;

  const { slug } = await ctx.params;
  if (!slug || slug.length === 0) return errorResponse(400, "INVALID_PATH");

  const endpointId = slug[0];
  const endpoint = getCustomEndpoint(endpointId);
  if (!endpoint) return errorResponse(404, "ENDPOINT_NOT_FOUND");

  if (slug.length === 1) {
    return Response.json(endpoint, { headers: { "Cache-Control": "no-store" } });
  }

  if (slug[1] === "models") {
    if (slug.length === 2) {
      return Response.json(endpoint.models, { headers: { "Cache-Control": "no-store" } });
    }
    const rawSegment = decodeURIComponent(slug.slice(2).join("/")).trim();
    const stripped = rawSegment.startsWith(`${endpointId}/`)
      ? rawSegment.slice(endpointId.length + 1)
      : rawSegment;
    const model = endpoint.models.find(
      (m) =>
        m.id === rawSegment ||
        m.upstream_id === rawSegment ||
        m.id === `${endpointId}/${rawSegment}` ||
        m.upstream_id === stripped ||
        m.id === `${endpointId}/${stripped}`
    );
    if (!model) return errorResponse(404, "MODEL_NOT_FOUND");
    return Response.json(model, { headers: { "Cache-Control": "no-store" } });
  }

  return errorResponse(404, "ROUTE_NOT_FOUND");
}

export async function POST(request: Request, ctx: RouteContext) {
  const auth = await authenticate(request, true);
  if (auth.error) return auth.error;

  const { slug } = await ctx.params;
  if (!slug || slug.length < 2) return errorResponse(400, "INVALID_PATH");

  const endpointId = slug[0];
  const endpoint = getCustomEndpoint(endpointId);
  if (!endpoint) return errorResponse(404, "ENDPOINT_NOT_FOUND");

  if (slug[1] !== "models") return errorResponse(404, "ROUTE_NOT_FOUND");

  // Synthetic connection test: POST .../models/{model_id}/test
  if (slug.length >= 4 && slug.at(-1) === "test") {
    const rawSegment = decodeURIComponent(slug.slice(2, -1).join("/")).trim();
    const stripped = rawSegment.startsWith(`${endpointId}/`)
      ? rawSegment.slice(endpointId.length + 1)
      : rawSegment;
    const model = endpoint.models.find(
      (m) =>
        m.id === rawSegment ||
        m.upstream_id === rawSegment ||
        m.id === `${endpointId}/${rawSegment}` ||
        m.upstream_id === stripped ||
        m.id === `${endpointId}/${stripped}`
    );
    if (!model) return errorResponse(404, "MODEL_NOT_FOUND");

    const apiKey = getDecryptedEndpointApiKey(endpointId);
    const result = await testCustomEndpointModel(endpoint.base_url, model.upstream_id, apiKey);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  }

  // Create model: POST .../models
  if (slug.length === 2) {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, "INVALID_JSON");
    }

    const parsed = createModelSchema.safeParse(body);
    if (!parsed.success) return errorResponse(400, "INVALID_MODEL_PAYLOAD");

    try {
      const created = createCustomEndpointModel(endpointId, parsed.data);
      return Response.json(created, { status: 201, headers: { "Cache-Control": "no-store" } });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "MODEL_ALREADY_EXISTS") return errorResponse(409, "MODEL_ALREADY_EXISTS");
      if (msg === "ENDPOINT_NOT_FOUND") return errorResponse(404, "ENDPOINT_NOT_FOUND");
      return errorResponse(500, "MODEL_CREATION_FAILED");
    }
  }

  return errorResponse(404, "ROUTE_NOT_FOUND");
}

export async function PUT(request: Request, ctx: RouteContext) {
  const auth = await authenticate(request, true);
  if (auth.error) return auth.error;

  const { slug } = await ctx.params;
  if (!slug || slug.length === 0) return errorResponse(400, "INVALID_PATH");

  const endpointId = slug[0];
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "INVALID_JSON");
  }

  // Update endpoint: PUT .../{id}
  if (slug.length === 1) {
    const parsed = updateEndpointSchema.safeParse(body);
    if (!parsed.success) return errorResponse(400, "INVALID_ENDPOINT_PAYLOAD");

    try {
      const updated = updateCustomEndpoint(endpointId, parsed.data);
      if (!updated) return errorResponse(404, "ENDPOINT_NOT_FOUND");
      return Response.json(updated, { headers: { "Cache-Control": "no-store" } });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("METADATA_ADDRESS_DENIED") ||
        msg.includes("INVALID_URL") ||
        msg.includes("INVALID_PROTOCOL")
      ) {
        return errorResponse(422, msg);
      }
      return errorResponse(500, "ENDPOINT_UPDATE_FAILED");
    }
  }

  // Update model: PUT .../{id}/models/{model_id}
  if (slug[1] === "models" && slug.length >= 3) {
    const modelSegment = decodeURIComponent(slug.slice(2).join("/"));
    const parsed = updateModelSchema.safeParse(body);
    if (!parsed.success) return errorResponse(400, "INVALID_MODEL_PAYLOAD");

    try {
      const updated = updateCustomEndpointModel(endpointId, modelSegment, parsed.data);
      if (!updated) return errorResponse(404, "MODEL_NOT_FOUND");
      return Response.json(updated, { headers: { "Cache-Control": "no-store" } });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "MODEL_ALREADY_EXISTS") return errorResponse(409, "MODEL_ALREADY_EXISTS");
      return errorResponse(500, "MODEL_UPDATE_FAILED");
    }
  }

  return errorResponse(404, "ROUTE_NOT_FOUND");
}

export async function DELETE(request: Request, ctx: RouteContext) {
  const auth = await authenticate(request, true);
  if (auth.error) return auth.error;

  const { slug } = await ctx.params;
  if (!slug || slug.length === 0) return errorResponse(400, "INVALID_PATH");

  const endpointId = slug[0];

  // Delete endpoint: DELETE .../{id}
  if (slug.length === 1) {
    const deleted = deleteCustomEndpoint(endpointId);
    if (!deleted) return errorResponse(404, "ENDPOINT_NOT_FOUND");
    return Response.json({ deleted: true }, { headers: { "Cache-Control": "no-store" } });
  }

  // Delete model: DELETE .../{id}/models/{model_id}
  if (slug[1] === "models" && slug.length >= 3) {
    const modelSegment = decodeURIComponent(slug.slice(2).join("/"));
    const deleted = deleteCustomEndpointModel(endpointId, modelSegment);
    if (!deleted) return errorResponse(404, "MODEL_NOT_FOUND");
    return Response.json({ deleted: true }, { headers: { "Cache-Control": "no-store" } });
  }

  return errorResponse(404, "ROUTE_NOT_FOUND");
}
