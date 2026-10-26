if (!process.env.DATA_DIR) throw new Error("Explicit primary DATA_DIR required");
const { getProviderNodes, updateProviderNode } =
  await import("../../src/lib/db/providers/nodes.ts");
const { getProviderConnections, updateProviderConnection } =
  await import("../../src/lib/db/providers.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
try {
  const node = (await getProviderNodes()).find((n) => n.prefix === "rissets");
  if (!node) throw new Error("Expected provider missing");
  await updateProviderNode(node.id, {
    customHeaders: { ...node.customHeaders, "Accept-Encoding": "identity" },
  });
  for (const c of await getProviderConnections({ provider: node.id })) {
    const data = c.providerSpecificData ?? {};
    await updateProviderConnection(c.id, {
      providerSpecificData: {
        ...data,
        customHeaders: { ...data.customHeaders, "Accept-Encoding": "identity" },
      },
    });
  }
  console.log(
    "Provider now requests identity encoding; credentials and remaining configuration preserved."
  );
} finally {
  resetDbInstance();
}
