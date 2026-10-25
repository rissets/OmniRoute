import { OMNIROUTE_RESPONSE_HEADERS } from "../../src/shared/constants/headers.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import bpBatamBrand from "../../scripts/docs/bp-batam-brand.mjs";
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
test("palette and typography implement the supplied independent brand contract", () => {
  const contract = JSON.parse(read("config/branding/bp-batam-contract.json"));
  const css = read("src/app/bp-batam.css");
  for (const role of [contract.color.brand, contract.color.light, contract.color.dark])
    for (const token of Object.values(role) as Array<{ value: string }>)
      assert.ok(
        css.toLowerCase().includes(token.value.toLowerCase()),
        `Missing source token ${token.value}`
      );
  for (const token of Object.values(contract.font) as Array<{ value: string }>)
    assert.ok(css.includes(token.value));
  assert.ok(read("src/app/globals.css").includes('@import "./bp-batam.css"'));
});
test("brand assets are real local binaries, including icon and fonts", () => {
  assert.deepEqual(
    [...fs.readFileSync("public/brand/bp-batam-logo.png").subarray(0, 4)],
    [137, 80, 78, 71]
  );
  assert.equal(
    fs
      .readFileSync("public/fonts/bp-batam/plus-jakarta-sans-latin-700-normal.woff2")
      .subarray(0, 4)
      .toString(),
    "wOF2"
  );
  assert.equal(fs.readFileSync("public/favicon.ico").readUInt16LE(2), 1);
});
test("all supported locale catalogs remove legacy manufacturer identity", () => {
  for (const file of fs.readdirSync("src/i18n/messages").filter((f) => f.endsWith(".json"))) {
    const data = JSON.parse(read("src/i18n/messages/" + file));
    const values = (x: unknown): string[] =>
      typeof x === "string"
        ? [x]
        : x && typeof x === "object"
          ? Object.values(x).flatMap(values)
          : [];
    assert.ok(
      values(data).every((v) => !/\bOmniRouter?\b|\bKeak\b/.test(v)),
      file
    );
  }
});
test("documentation is branded without renaming MCP compatibility tool ids", () => {
  const tree = {
    type: "root",
    children: [
      { type: "text", value: "OmniRoute with Keak" },
      { type: "inlineCode", value: "omniroute_get_health" },
      { type: "link", url: "https://omniroute.online", children: [] },
    ],
  };
  bpBatamBrand()(tree);
  assert.equal(tree.children[0].value, "BP Batam AI Gateway with BP Batam");
  assert.equal(tree.children[1].value, "omniroute_get_health");
  assert.equal(tree.children[2].url, "/dashboard/help");
});
test("home does not render sponsor campaigns", () => {
  const src = read("src/app/(dashboard)/home/page.tsx");
  assert.doesNotMatch(
    src,
    /<(?:KimiSponsorBanner|CheaperInferenceSponsorBanner|VscodeCopilotBanner|NewsBanner)/
  );
  assert.match(src, /<BpBatamServiceBanner/);
});

test("HTTP response header names keep the interoperable protocol contract", () => {
  const headers = read("src/shared/constants/headers.ts");
  assert.match(headers, /X-OmniRoute-Cache/);
  assert.doesNotMatch(headers, /X-BP Batam/);
});

test("every emitted telemetry header remains valid HTTP syntax", () => {
  assert.doesNotThrow(
    () =>
      new Headers(
        Object.fromEntries(Object.values(OMNIROUTE_RESPONSE_HEADERS).map((name) => [name, "test"]))
      )
  );
});

test("provider credential onboarding retains its provider destination", () => {
  const source = read("src/shared/constants/providers/apikey/gateways.ts");
  assert.match(source, /website: "https:\/\/cheaperinference\.com\/"/);
  assert.ok(source.includes("Create an API key at https://cheaperinference.com/ (needs"));
  assert.ok(!source.includes("Create an API key at https://bpbatam.go.id"));
});
