import { NextResponse } from "next/server";
import {
  BP_ROUTE_PROVIDER_LOCKED_CODE,
  BP_ROUTE_PROVIDER_LOCKED_MESSAGE,
  isAllowedBpRouteProviderId,
  isBpRouteProviderHardLockEnabled,
  type BpRouteProviderNodeLike,
} from "@/shared/constants/bpRouteProviderPolicy";

export function bpRouteProviderLockedResponse(): NextResponse {
  return NextResponse.json(
    {
      error: BP_ROUTE_PROVIDER_LOCKED_MESSAGE,
      code: BP_ROUTE_PROVIDER_LOCKED_CODE,
    },
    { status: 403 }
  );
}

export function rejectDisallowedBpRouteProvider(
  providerId: unknown,
  providerNode?: BpRouteProviderNodeLike | null
): NextResponse | null {
  if (!isBpRouteProviderHardLockEnabled()) return null;
  if (isAllowedBpRouteProviderId(providerId, providerNode)) return null;
  return bpRouteProviderLockedResponse();
}

export function filterAllowedBpRouteConnections<T extends { provider?: unknown }>(
  connections: T[]
): T[] {
  if (!isBpRouteProviderHardLockEnabled()) return connections;
  return connections.filter((conn) => isAllowedBpRouteProviderId(conn?.provider));
}
