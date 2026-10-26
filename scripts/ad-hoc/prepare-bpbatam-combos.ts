if (!process.env.DATA_DIR) throw new Error("Explicit primary DATA_DIR required");
const { publishedOffers } = await import("../../src/lib/bpbatam/offers.ts");
const { getComboByName, createCombo } = await import("../../src/lib/db/combos.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
try {
  const offers = await publishedOffers();
  const luna = offers.find((o) => o.kind === "model" && o.id.endsWith("gpt-6-luna"));
  const qwen = offers.find((o) => o.kind === "model" && o.id.endsWith("qwen3.8-27b"));
  const deepseek = offers.find((o) => o.kind === "model" && o.id.endsWith("deepseek-v4.1-flash"));
  if (!luna || !qwen || !deepseek) throw new Error("Required primary model targets missing");
  const combos = [
    { name: "bp-batam-cepat", models: [luna.id] },
    { name: "bp-batam-qwen", models: [qwen.id] },
    { name: "bp-batam-cadangan", models: [luna.id, deepseek.id] },
  ];
  for (const combo of combos)
    if (!(await getComboByName(combo.name)))
      await createCombo({ ...combo, strategy: "priority", config: {} });
  console.log(
    JSON.stringify({ combos: combos.map((c) => c.name), targets: combos.map((c) => c.models) })
  );
} finally {
  resetDbInstance();
}
