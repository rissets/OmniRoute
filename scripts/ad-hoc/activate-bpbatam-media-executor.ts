/** Run only against the explicitly selected primary DATA_DIR after taking a ledger/config backup. */
if (!process.env.DATA_DIR || !process.env.BPBATAM_MEDIA_EXECUTOR_URL)
  throw new Error("Explicit primary DATA_DIR and executor URL required");
const { getProviderNodes, updateProviderNode } =
  await import("../../src/lib/db/providers/nodes.ts");
const { getProviderConnections, updateProviderConnection } =
  await import("../../src/lib/db/providers.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
let nodes = 0;
let connections = 0;
try {
  for (const node of await getProviderNodes()) {
    if (!["local-tts", "local-stt", "local-image"].includes(String(node.prefix))) continue;
    await updateProviderNode(String(node.id), {
      baseUrl: process.env.BPBATAM_MEDIA_EXECUTOR_URL + "/v1",
    });
    nodes++;
    for (const connection of await getProviderConnections({ provider: node.id })) {
      await updateProviderConnection(String(connection.id), {
        isActive: false,
        apiKey: "managed-media-executor-only",
        testStatus: "managed-executor",
        providerSpecificData: {
          ...((connection.providerSpecificData as object) ?? {}),
          baseUrl: process.env.BPBATAM_MEDIA_EXECUTOR_URL + "/v1",
          bpbatamManagedMedia: true,
        },
      });
      connections++;
    }
  }
  if (nodes !== 3) throw new Error("Expected exactly three published primary media providers");
  console.log(
    JSON.stringify({ migrated_provider_nodes: nodes, retired_legacy_connections: connections })
  );
} finally {
  resetDbInstance();
}
