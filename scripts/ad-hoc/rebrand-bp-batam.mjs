import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
const root = process.cwd();
const rewrite = (value) =>
  value
    .replace(
      /https?:\/\/(?:www\.)?(?:omniroute\.online|keak\.ai)[^\s"'<>)]*/gi,
      "https://bpbatam.go.id"
    )
    .replace(
      /https:\/\/github\.com\/(?:cheaper-inference|diegosouzapw)\/OmniRoute[^\s"'<>)]*/gi,
      "/dashboard/help"
    )
    .replace(/https:\/\/www\.npmjs\.com\/package\/omniroute/gi, "/dashboard/help")
    .replace(/[\w.+-]+@(?:omniroute\.[\w.]+|keak\.ai)/gi, "humas@bpbatam.go.id")
    .replace(/\bOmniRouter?\b/g, "BP Batam AI Gateway")
    .replace(/\bOMNIROUTE\b(?!_)/g, "BP BATAM")
    .replace(/\bKeak\b/g, "BP Batam")
    .replace(/\bOmniProxy\b/g, "Gateway AI")
    .replace(/\bOmniSkills\b/g, "Keterampilan AI")
    .replace(/\bOmniCopilot\b/g, "Integrasi IDE")
    .replace(/BP Batam AI Gateway (?:AI Gateway|AI 网关)/g, "BP Batam AI Gateway");
let touched = 0;
function visit(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (file.includes("/src/app/api/")) continue;
    if (entry.isDirectory()) {
      if (!["__tests__", "node_modules"].includes(entry.name)) visit(file);
      continue;
    }
    if (/\.json$/.test(file) && file.includes("/i18n/")) {
      let original = fs.readFileSync(file, "utf8");
      let object = JSON.parse(original);
      const transform = (x) =>
        typeof x === "string"
          ? rewrite(x)
          : Array.isArray(x)
            ? x.map(transform)
            : x && typeof x === "object"
              ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, transform(v)]))
              : x;
      const updated = JSON.stringify(transform(object), null, 2) + "\n";
      if (updated !== original) {
        fs.writeFileSync(file, updated);
        touched++;
      }
      continue;
    }
    if (!/\.tsx?$/.test(file) || /\.(?:test|spec)\./.test(file)) continue;
    const original = fs.readFileSync(file, "utf8");
    const source = ts.createSourceFile(
      file,
      original,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const edits = [];
    function walk(node) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isJsxText(node) ||
        node.kind === ts.SyntaxKind.TemplateHead ||
        node.kind === ts.SyntaxKind.TemplateMiddle ||
        node.kind === ts.SyntaxKind.TemplateTail
      ) {
        const start = node.getStart(source),
          end = node.getEnd();
        let segment = original.slice(start, end);
        // Module paths and persistence/protocol keys are compatibility identifiers.
        if (
          !ts.isJsxText(node) &&
          !/^['"`]https?:/.test(segment) &&
          (/^["'`]\.\.?\//.test(segment) || /^['"](?:@|[a-z][a-z0-9:_./-]*['"]$)/.test(segment))
        )
          return;
        if (
          /^['"`](?:X-OmniRoute-|cheaper-inference\/|https:\/\/raw\.githubusercontent\.com)/.test(
            segment
          )
        )
          return;
        const updated = rewrite(segment);
        if (updated !== segment) edits.push([start, end, updated]);
        return;
      }
      ts.forEachChild(node, walk);
    }
    walk(source);
    let updated = original;
    for (const [start, end, value] of edits.sort((a, b) => b[0] - a[0]))
      updated = updated.slice(0, start) + value + updated.slice(end);
    if (updated !== original) {
      fs.writeFileSync(file, updated);
      touched++;
    }
  }
}
for (const dir of [
  "src/app",
  "src/shared/components",
  "src/shared/constants",
  "src/i18n",
  "open-sse/mcp-server",
  "src/lib/a2a",
])
  visit(path.join(root, dir));
console.log(
  "Updated presentation copy in",
  touched,
  "files; imports and compatibility identifiers retained."
);
