/**
 * Organization reserve and shareable-token ledger.
 *
 * GET  /api/usage/organization-reserve?apiKeyId=...
 * PUT  { apiKeyId, period, monthlyTokenLimit, baseUserTokens, sharedAllocatedTokens }
 * POST { action: "resetDebit", apiKeyId, period, subjectId, tokens, resetInterval, idempotencyKey }
 */

import { NextResponse } from "next/server";
import { buildErrorBody, sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import {
  addOrganizationResetDebit,
  getOrganizationReserve,
  OrganizationReserveCapacityError,
  setOrganizationReserve,
} from "@/lib/db/organizationReserve";

function apiKeyIdFrom(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const apiKeyId = apiKeyIdFrom(searchParams.get("apiKeyId"));
    if (!apiKeyId) {
      return NextResponse.json(buildErrorBody(400, "apiKeyId query param is required"), { status: 400 });
    }
    return NextResponse.json(getOrganizationReserve(apiKeyId, searchParams.get("period") || undefined));
  } catch (error) {
    console.error("Error reading organization reserve:", error);
    return NextResponse.json(buildErrorBody(500, sanitizeErrorMessage(error)), { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const apiKeyId = apiKeyIdFrom(body.apiKeyId);
    if (!apiKeyId) {
      return NextResponse.json(buildErrorBody(400, "apiKeyId is required"), { status: 400 });
    }
    const reserve = setOrganizationReserve({
      apiKeyId,
      period: typeof body.period === "string" ? body.period : undefined,
      monthlyTokenLimit: body.monthlyTokenLimit as number | undefined,
      baseUserTokens: body.baseUserTokens as number | undefined,
      sharedAllocatedTokens: body.sharedAllocatedTokens as number | undefined,
    });
    return NextResponse.json({ success: true, reserve });
  } catch (error) {
    console.error("Error configuring organization reserve:", error);
    return NextResponse.json(buildErrorBody(400, sanitizeErrorMessage(error)), { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (body.action !== "resetDebit") {
      return NextResponse.json(buildErrorBody(400, "action must be resetDebit"), { status: 400 });
    }
    const apiKeyId = apiKeyIdFrom(body.apiKeyId);
    if (!apiKeyId) {
      return NextResponse.json(buildErrorBody(400, "apiKeyId is required"), { status: 400 });
    }
    if (body.resetInterval !== "5h" && body.resetInterval !== "weekly") {
      return NextResponse.json(buildErrorBody(400, "resetInterval must be 5h or weekly"), { status: 400 });
    }
    const result = addOrganizationResetDebit({
      apiKeyId,
      period: typeof body.period === "string" ? body.period : undefined,
      subjectId: typeof body.subjectId === "string" ? body.subjectId : "",
      tokens: body.tokens as number,
      resetInterval: body.resetInterval,
      idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : "",
      reason: typeof body.reason === "string" ? body.reason : undefined,
      metadata: body.metadata && typeof body.metadata === "object" ? (body.metadata as Record<string, unknown>) : {},
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof OrganizationReserveCapacityError) {
      return NextResponse.json(
        buildErrorBody(409, error.message, { availableTokens: error.availableTokens }),
        { status: 409 }
      );
    }
    console.error("Error recording organization reset debit:", error);
    return NextResponse.json(buildErrorBody(400, sanitizeErrorMessage(error)), { status: 400 });
  }
}
