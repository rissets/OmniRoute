import { mediaRevision, bumpMediaRevision } from "@/lib/db/bpbatam";
import { TokenPolicyError } from "@/lib/db/bpbatam";

let cachedToken: { token: string; until: number } | undefined;
let pendingToken: Promise<string> | undefined;

export function integratedMedia(): boolean {
  return !!process.env.BPBATAM_MEDIA_EXECUTOR_URL;
}

export async function mediaToken(): Promise<string> {
  if (cachedToken && cachedToken.until > Date.now() + 15000) return cachedToken.token;
  if (pendingToken) return pendingToken;
  pendingToken = (async () => {
    const issuer = process.env.BPBATAM_OIDC_ISSUER;
    const secret = process.env.BPBATAM_MEDIA_CLIENT_SECRET;
    if (!issuer || !secret)
      throw new TokenPolicyError("MEDIA_EXECUTOR_CONFIGURATION_REQUIRED", 503);
    const response = await fetch(issuer + "/protocol/openid-connect/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: process.env.BPBATAM_MEDIA_CLIENT_ID ?? "bpbatam-router-media",
        client_secret: secret,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new TokenPolicyError("MEDIA_EXECUTOR_AUTH_UNAVAILABLE", 503);
    const data = await response.json();
    if (typeof data.access_token !== "string" || typeof data.expires_in !== "number")
      throw new TokenPolicyError("MEDIA_EXECUTOR_AUTH_UNAVAILABLE", 503);
    cachedToken = { token: data.access_token, until: Date.now() + data.expires_in * 1000 };
    return cachedToken.token;
  })();
  try {
    return await pendingToken;
  } finally {
    pendingToken = undefined;
  }
}

export async function mediaCatalogRevision(): Promise<string> {
  if (!integratedMedia()) return mediaRevision();
  const config = await mediaSettings();
  if (typeof config.revision !== "string" || !/^[a-f0-9]{64}$/.test(config.revision))
    throw new TokenPolicyError("MEDIA_CONFIGURATION_UNAVAILABLE", 503);
  return config.revision;
}

export async function mediaSettings(method = "GET", kind?: string, data?: object) {
  if (integratedMedia()) {
    if (method !== "GET") throw new TokenPolicyError("USE_CONTROL_PANEL_MEDIA_SETTINGS", 409);
    const response = await fetch(process.env.BPBATAM_MEDIA_EXECUTOR_URL + "/settings", {
      headers: { Authorization: "Bearer " + (await mediaToken()) },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new TokenPolicyError("MEDIA_CONFIGURATION_UNAVAILABLE", 503);
    return response.json();
  }
  const origin = process.env.BPBATAM_MEDIA_URL;
  const key = process.env.BPBATAM_MEDIA_KEY;
  if (!origin || !key) throw new Error("MEDIA_ADAPTER_CONFIGURATION_REQUIRED");
  const response = await fetch(
    origin + "/control/settings" + (kind ? "/" + encodeURIComponent(kind) : ""),
    {
      method,
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      ...(data ? { body: JSON.stringify(data) } : {}),
      signal: AbortSignal.timeout(15000),
    }
  );
  if (!response.ok) throw new Error("MEDIA_ADAPTER_REJECTED");
  if (method !== "GET") bumpMediaRevision();
  return response.json();
}
