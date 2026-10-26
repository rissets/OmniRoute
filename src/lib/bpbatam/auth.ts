import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

let cached: { issuer: string; keys: ReturnType<typeof createRemoteJWKSet> } | undefined;
export async function bridgeIdentity(request: Request): Promise<JWTPayload | null> {
  const issuer = process.env.BPBATAM_OIDC_ISSUER;
  const audience = process.env.BPBATAM_SERVICE_AUDIENCE;
  const token = request.headers.get("authorization")?.match(/^Bearer ([^ ]+)$/i)?.[1];
  if (!issuer || !audience || !token) return null;
  try {
    if (cached?.issuer !== issuer)
      cached = {
        issuer,
        keys: createRemoteJWKSet(
          new URL(process.env.BPBATAM_JWKS_URL ?? issuer + "/protocol/openid-connect/certs")
        ),
      };
    const { payload } = await jwtVerify(token, cached.keys, {
      issuer,
      audience,
      algorithms: ["RS256"],
    });
    if (typeof payload.sub !== "string" || typeof payload.azp !== "string") return null;
    return payload;
  } catch {
    return null;
  }
}
export function bridgeRoles(identity: JWTPayload): string[] {
  const realm = identity.realm_access as { roles?: unknown } | undefined;
  return Array.isArray(realm?.roles)
    ? realm.roles.filter((x): x is string => typeof x === "string" && x.startsWith("bp:"))
    : [];
}
