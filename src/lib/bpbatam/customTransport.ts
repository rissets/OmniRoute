/**
 * Safe transport for managed custom endpoints:
 * - Rejects cloud metadata addresses (both hostname and every resolved IP)
 * - Pinned DNS / socket binding to prevent DNS rebinding attacks (GHSA-cmhj-wh2f-9cgx)
 * - Rejects HTTP redirects fail-closed (direct target URL required per spec)
 * - No logging or leaking of secrets
 * - Supports streaming (SSE) and non-streaming dispatch
 */

import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isCloudMetadataHost } from "@/shared/network/outboundUrlGuard";

export function validateCustomEndpointUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = input instanceof URL ? input : new URL(String(input));
  } catch {
    throw new Error("INVALID_URL: Failed to parse endpoint URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("INVALID_PROTOCOL: Endpoint URL must use http or https protocol");
  }
  if (url.username || url.password) {
    throw new Error(
      "EMBEDDED_CREDENTIALS_FORBIDDEN: Endpoint URL must not contain embedded credentials"
    );
  }
  if (isCloudMetadataHost(url.hostname)) {
    throw new Error("METADATA_ADDRESS_DENIED: Cloud metadata addresses are blocked");
  }
  return url;
}

export function isManagedCustomEndpoint(
  provider?: string,
  url?: string,
  credentials?: any
): boolean {
  if (credentials?.providerSpecificData?.isCustomEndpoint === true) return true;
  if (
    typeof provider === "string" &&
    (provider.startsWith("custom-") || provider.startsWith("custom/") || provider === "custom")
  ) {
    return true;
  }
  try {
    const { getDbInstance } = require("@/lib/db/core");
    const db = getDbInstance();
    if (provider) {
      const row = db.prepare("SELECT 1 FROM bp_custom_endpoints WHERE id = ?").get(provider);
      if (row) return true;
    }
    if (url) {
      const parsed = new URL(url);
      const origin = parsed.origin;
      const row = db
        .prepare(
          "SELECT 1 FROM bp_custom_endpoints WHERE instr(base_url, ?) > 0 OR instr(?, base_url) > 0 LIMIT 1"
        )
        .get(origin, origin);
      if (row) return true;
    }
  } catch {
    // Fail-open query check, fallback to false if DB uninitialized
  }
  return false;
}

export async function safePinnedFetch(
  input: string | URL,
  init: RequestInit = {},
  options?: { lookupFn?: typeof lookup; timeoutMs?: number }
): Promise<Response> {
  const url = validateCustomEndpointUrl(input);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const lookupImpl = options?.lookupFn ?? lookup;
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookupImpl(host, { all: true });

  if (!addresses.length) {
    throw new Error("DNS_LOOKUP_FAILED: Could not resolve hostname " + host);
  }

  for (const entry of addresses) {
    if (isCloudMetadataHost(entry.address) || entry.address.startsWith("169.254.")) {
      throw new Error(
        "METADATA_ADDRESS_DENIED: Resolved IP " +
          entry.address +
          " is a blocked cloud metadata address"
      );
    }
  }

  const selected = addresses[0];
  const isHttps = url.protocol === "https:";
  const method = (init.method || "GET").toUpperCase();

  const reqHeaders: Record<string, string | string[]> = {};
  if (init.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((v, k) => {
        reqHeaders[k] = v;
      });
    } else if (Array.isArray(init.headers)) {
      for (const [k, v] of init.headers) {
        reqHeaders[k] = v;
      }
    } else {
      Object.assign(reqHeaders, init.headers);
    }
  }
  reqHeaders["Host"] = url.host;

  const requestOptions: https.RequestOptions & { autoSelectFamily?: boolean } = {
    method,
    agent: false,
    family: selected.family,
    autoSelectFamily: false,
    lookup: (_name, _opts, callback) => callback(null, selected.address, selected.family),
    servername: isIP(host) ? undefined : host,
    headers: reqHeaders,
  };

  const { promise, resolve, reject } = Promise.withResolvers<Response>();

  const req = (isHttps ? https : http).request(url, requestOptions, (res) => {
    // GHSA-cmhj-wh2f-9cgx: Protect against redirects to cloud metadata / internal targets
    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
      req.destroy();
      reject(
        new Error(
          `REDIRECT_DENIED: Endpoint returned HTTP ${res.statusCode} redirect. Direct target URL is required.`
        )
      );
      return;
    }

    const responseHeaders = new Headers();
    for (const [k, v] of Object.entries(res.headers)) {
      if (Array.isArray(v)) {
        for (const item of v) responseHeaders.append(k, item);
      } else if (v !== undefined) {
        responseHeaders.set(k, v);
      }
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        res.on("data", (chunk: Buffer) => {
          controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        });
        res.on("end", () => {
          controller.close();
        });
        res.on("error", (err) => {
          controller.error(err);
        });
      },
      cancel() {
        req.destroy();
      },
    });

    const response = new Response(method === "HEAD" ? null : stream, {
      status: res.statusCode ?? 502,
      statusText: res.statusMessage ?? "",
      headers: responseHeaders,
    });
    resolve(response);
  });

  const timeoutMs = options?.timeoutMs ?? 180000;
  const timer = setTimeout(() => {
    req.destroy(new Error("REQUEST_TIMEOUT: Request timed out after " + timeoutMs + "ms"));
  }, timeoutMs);

  req.once("close", () => clearTimeout(timer));
  req.on("error", (err) => {
    clearTimeout(timer);
    reject(err);
  });

  if (init.signal) {
    if (init.signal.aborted) {
      req.destroy(new Error("Request aborted"));
      reject(new Error("Request aborted"));
      return promise;
    }
    init.signal.addEventListener(
      "abort",
      () => {
        req.destroy(new Error("Request aborted"));
      },
      { once: true }
    );
  }

  if (init.body) {
    if (typeof init.body === "string" || Buffer.isBuffer(init.body)) {
      req.end(init.body);
    } else if (init.body instanceof Uint8Array) {
      req.end(Buffer.from(init.body));
    } else if (typeof (init.body as any).getReader === "function") {
      const reader = (init.body as ReadableStream<Uint8Array>).getReader();
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) req.write(Buffer.from(value));
          }
          req.end();
        } catch (err) {
          req.destroy(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    } else {
      req.end(String(init.body));
    }
  } else {
    req.end();
  }

  return promise;
}

export async function safePinnedPost(
  url: URL,
  body: string,
  secret?: string | null,
  timeoutMs = 15000,
  options?: { lookupFn?: typeof lookup }
): Promise<{ status: number; body: string; latencyMs: number }> {
  validateCustomEndpointUrl(url);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const lookupImpl = options?.lookupFn ?? lookup;
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookupImpl(host, { all: true });

  if (!addresses.length) {
    throw new Error("DNS_LOOKUP_FAILED: Could not resolve hostname " + host);
  }

  for (const entry of addresses) {
    if (isCloudMetadataHost(entry.address) || entry.address.startsWith("169.254.")) {
      throw new Error(
        "METADATA_ADDRESS_DENIED: Resolved IP " +
          entry.address +
          " is a blocked cloud metadata address"
      );
    }
  }

  const selected = addresses[0];
  const startTime = Date.now();

  const { promise, resolve, reject } = Promise.withResolvers<{
    status: number;
    body: string;
    latencyMs: number;
  }>();
  const isHttps = url.protocol === "https:";
  const requestOptions: https.RequestOptions & { autoSelectFamily?: boolean } = {
    method: "POST",
    agent: false,
    family: selected.family,
    autoSelectFamily: false,
    lookup: (_name, _opts, callback) => callback(null, selected.address, selected.family),
    servername: isIP(host) ? undefined : host,
    headers: {
      "Content-Type": "application/json",
      "Accept-Encoding": "identity",
      "Content-Length": Buffer.byteLength(body),
      Host: url.host,
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    },
  };

  const req = (isHttps ? https : http).request(url, requestOptions, (res) => {
    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
      req.destroy();
      resolve({
        status: res.statusCode,
        body: "REDIRECT_DENIED: Redirects are not permitted; provide direct target URL",
        latencyMs: Date.now() - startTime,
      });
      return;
    }

    let bytes = 0;
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) {
        req.destroy(new Error("RESPONSE_TOO_LARGE: Response exceeded 256KB"));
      } else {
        chunks.push(chunk);
      }
    });

    res.on("end", () => {
      resolve({
        status: res.statusCode ?? 502,
        body: Buffer.concat(chunks).toString("utf8"),
        latencyMs: Date.now() - startTime,
      });
    });

    res.on("error", reject);
  });

  const timer = setTimeout(() => {
    req.destroy(new Error("REQUEST_TIMEOUT: Request timed out after " + timeoutMs + "ms"));
  }, timeoutMs);

  req.once("close", () => clearTimeout(timer));
  req.setTimeout(timeoutMs, () => {
    req.destroy(new Error("REQUEST_TIMEOUT: Socket timed out"));
  });
  req.on("error", reject);
  req.end(body);

  return promise;
}

export async function testCustomEndpointModel(
  baseUrl: string,
  upstreamId: string,
  apiKey?: string | null,
  options?: { lookupFn?: typeof lookup }
): Promise<{ ok: boolean; latency_ms?: number; error?: string }> {
  try {
    const parsed = validateCustomEndpointUrl(baseUrl);
    const trimmedBase = parsed.origin + parsed.pathname.replace(/\/+$/, "");
    const targetUrl = new URL(
      trimmedBase.endsWith("/chat/completions") ? trimmedBase : `${trimmedBase}/chat/completions`
    );
    const payload = JSON.stringify({
      model: upstreamId,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 5,
    });
    const result = await safePinnedPost(targetUrl, payload, apiKey, 15000, options);
    if (result.status >= 200 && result.status < 300) {
      return { ok: true, latency_ms: result.latencyMs };
    }
    if (result.status >= 300 && result.status < 400) {
      return {
        ok: false,
        error: `REDIRECT_DENIED: Endpoint returned HTTP ${result.status} redirect. Direct target URL is required.`,
      };
    }
    const snippet = result.body.slice(0, 300).trim();
    return {
      ok: false,
      error: `HTTP ${result.status}${snippet ? ": " + snippet : ""}`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: msg,
    };
  }
}
