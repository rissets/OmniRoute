import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { lookup } from "node:dns/promises";
import {
  validateCustomEndpointUrl,
  safePinnedFetch,
  testCustomEndpointModel,
} from "../../src/lib/bpbatam/customTransport.ts";
import { dispatchGuarded } from "../../open-sse/executors/dispatchPin.ts";

test("validateCustomEndpointUrl rejects invalid protocols and embedded credentials", () => {
  assert.throws(() => validateCustomEndpointUrl("ftp://my-server.internal/v1"), {
    message: /INVALID_PROTOCOL/,
  });
  assert.throws(() => validateCustomEndpointUrl("http://admin:secret@10.0.0.1/v1"), {
    message: /EMBEDDED_CREDENTIALS_FORBIDDEN/,
  });
  assert.throws(() => validateCustomEndpointUrl("not a valid url"), {
    message: /INVALID_URL/,
  });

  // Valid internal and public URLs pass validation
  assert.equal(
    validateCustomEndpointUrl("http://127.0.0.1:8000/v1").origin,
    "http://127.0.0.1:8000"
  );
  assert.equal(
    validateCustomEndpointUrl("https://10.200.1.5:8443/v1").origin,
    "https://10.200.1.5:8443"
  );
  assert.equal(
    validateCustomEndpointUrl("https://api.openai.com/v1").origin,
    "https://api.openai.com"
  );
});

test("validateCustomEndpointUrl unconditionally blocks cloud metadata hostnames", () => {
  const blockedHosts = [
    "http://169.254.169.254/latest/meta-data",
    "http://169.254.1.1/v1",
    "http://metadata.google.internal/computeMetadata/v1",
    "http://metadata.goog",
    "http://100.100.100.200/latest/meta-data",
    "http://168.63.129.16/metadata",
    "http://192.0.0.192/latest",
    "http://[fd00:ec2::254]/latest/meta-data",
    "http://[::ffff:169.254.169.254]/v1",
  ];

  for (const target of blockedHosts) {
    assert.throws(
      () => validateCustomEndpointUrl(target),
      { message: /METADATA_ADDRESS_DENIED/ },
      `Expected ${target} to be blocked as metadata`
    );
  }
});

test("safePinnedFetch blocks hostnames resolving to cloud metadata addresses (DNS check)", async () => {
  const fakeLookup = async () => [{ address: "169.254.169.254", family: 4 }];

  await assert.rejects(
    async () => {
      await safePinnedFetch(
        "http://innocent-looking-domain.com/v1/chat/completions",
        {},
        {
          lookupFn: fakeLookup as typeof lookup,
        }
      );
    },
    { message: /METADATA_ADDRESS_DENIED/ }
  );

  const fakeLookupMapped = async () => [{ address: "::ffff:169.254.169.254", family: 6 }];

  await assert.rejects(
    async () => {
      await safePinnedFetch(
        "http://innocent-looking-domain.com/v1/chat/completions",
        {},
        {
          lookupFn: fakeLookupMapped as typeof lookup,
        }
      );
    },
    { message: /METADATA_ADDRESS_DENIED/ }
  );
});

test("safePinnedFetch rejects HTTP redirects fail-closed", async () => {
  // Setup a test server that issues a 302 redirect
  const redirectServer = http.createServer((_req, res) => {
    res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" });
    res.end();
  });

  const { promise, resolve } = Promise.withResolvers<void>();
  redirectServer.listen(0, "127.0.0.1", () => resolve());
  await promise;

  const addr = redirectServer.address() as AddressInfo;
  const targetUrl = `http://127.0.0.1:${addr.port}/chat/completions`;

  try {
    await assert.rejects(
      async () => {
        await safePinnedFetch(targetUrl, { method: "POST", body: "{}" });
      },
      { message: /REDIRECT_DENIED/ }
    );

    // Also test through testCustomEndpointModel
    const testResult = await testCustomEndpointModel(`http://127.0.0.1:${addr.port}`, "test-model");
    assert.equal(testResult.ok, false);
    assert.match(testResult.error ?? "", /REDIRECT_DENIED/);
  } finally {
    redirectServer.close();
  }
});

test("safePinnedFetch connects to pinned IP preventing DNS rebinding during socket connect", async () => {
  let requestHandledOnServer = false;
  const mockServer = http.createServer((_req, res) => {
    requestHandledOnServer = true;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });

  const { promise, resolve } = Promise.withResolvers<void>();
  mockServer.listen(0, "127.0.0.1", () => resolve());
  await promise;

  const addr = mockServer.address() as AddressInfo;

  try {
    // Simulated DNS resolution returning mock server IP
    const lookupFn = async () => [{ address: "127.0.0.1", family: 4 }];

    // URL has hostname 'my-custom-ai.internal' but pinned to 127.0.0.1
    const res = await safePinnedFetch(
      `http://my-custom-ai.internal:${addr.port}/v1/models`,
      {},
      {
        lookupFn: lookupFn as typeof lookup,
      }
    );

    assert.equal(res.status, 200);
    assert.equal(requestHandledOnServer, true);
    const body = await res.json();
    assert.deepEqual(body, { ok: true });
  } finally {
    mockServer.close();
  }
});

test("safePinnedFetch streams response chunks correctly", async () => {
  const streamServer = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: 1\n\n");
    setTimeout(() => {
      res.write("data: 2\n\n");
      res.end();
    }, 20);
  });

  const { promise, resolve } = Promise.withResolvers<void>();
  streamServer.listen(0, "127.0.0.1", () => resolve());
  await promise;

  const addr = streamServer.address() as AddressInfo;

  try {
    const res = await safePinnedFetch(`http://127.0.0.1:${addr.port}/chat/completions`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(res.status, 200);

    const reader = res.body!.getReader();
    const chunks: string[] = [];
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }
    const full = chunks.join("");
    assert.match(full, /data: 1/);
    assert.match(full, /data: 2/);
  } finally {
    streamServer.close();
  }
});

test("dispatchGuarded routes custom endpoints to safePinnedFetch rejecting redirects and metadata", async () => {
  const redirectServer = http.createServer((_req, res) => {
    res.writeHead(307, { Location: "http://169.254.169.254/latest/meta-data" });
    res.end();
  });

  const { promise, resolve } = Promise.withResolvers<void>();
  redirectServer.listen(0, "127.0.0.1", () => resolve());
  await promise;

  const addr = redirectServer.address() as AddressInfo;
  const targetUrl = `http://127.0.0.1:${addr.port}/chat/completions`;

  try {
    // Tagged as custom endpoint in credentials
    await assert.rejects(
      async () => {
        await dispatchGuarded(
          "custom-provider",
          targetUrl,
          { method: "POST", body: "{}" },
          {
            providerSpecificData: {
              isCustomEndpoint: true,
              baseUrl: `http://127.0.0.1:${addr.port}`,
            },
          }
        );
      },
      { message: /REDIRECT_DENIED/ }
    );
  } finally {
    redirectServer.close();
  }
});
