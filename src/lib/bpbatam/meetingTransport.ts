/** Direct pinned socket transport; no proxy, redirects, retries or content logging. */
import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { TokenPolicyError } from "@/lib/db/bpbatam";
const fail = (code: string): never => {
  throw new TokenPolicyError(code, 403);
};

export async function pinnedMeetingPost(
  url: URL,
  deployment: { ip_addresses: string[] },
  secret: string,
  body: string,
  onDispatch: (address: string) => void,
  method: "POST" | "DELETE" = "POST"
) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true });
  if (
    !addresses.length ||
    addresses.some((entry) => !deployment.ip_addresses.includes(entry.address))
  )
    fail("MEETING_DESTINATION_ADDRESS_DENIED");
  const selected = addresses[0];
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    onDispatch(selected.address);
    const options: https.RequestOptions & { autoSelectFamily: boolean } = {
      method,
      agent: false,
      family: selected.family,
      autoSelectFamily: false,
      // Direct native socket with pinned DNS, original Host and TLS SNI. Ambient fetch/proxy patches cannot reroute it.
      lookup: (_name, _options, callback) => callback(null, selected.address, selected.family),
      servername: isIP(host) ? undefined : host,
      headers: {
        "Content-Type": "application/json",
        "Accept-Encoding": "identity",
        "Content-Length": Buffer.byteLength(body),
        Authorization: "Bearer " + secret,
        Host: url.host,
      },
    };
    const request = (url.protocol === "https:" ? https : http).request(url, options, (response) => {
      let bytes = 0;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 256000) request.destroy(new Error("MEETING_COMPLETION_TOO_LARGE"));
        else chunks.push(chunk);
      });
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 502,
          body: Buffer.concat(chunks).toString("utf8"),
        })
      );
      response.on("error", reject);
    });
    const deadline = setTimeout(
      () => request.destroy(new Error("MEETING_COMPLETION_TIMEOUT")),
      180000
    );
    request.once("close", () => clearTimeout(deadline));
    request.setTimeout(180000, () => request.destroy(new Error("MEETING_COMPLETION_TIMEOUT")));
    request.on("error", reject);
    request.end(body);
  });
}
