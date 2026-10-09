import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

// Generation resolves Commands and Recipes only through the catalogue repositories (static bootstrap
// adapter today, DYAI-39 persistence later). Nothing on the generation path may read the catalogue
// or recipe JSON itself, or the static in-memory contract in src/server/contract: either would be a
// second runtime truth next to the repositories.

const ROOT = fs.realpathSync(".");
const SRC = path.join(ROOT, "src");
const CODE = /\.(?:[cm]?[jt]sx?)$/;
const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const GAP = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*`;
const SPECIFIER = new RegExp(String.raw`(?:\bfrom${GAP}|\bimport${GAP}(?:\(${GAP})?|\brequire${GAP}\(${GAP})(["'\x60])([^"'\x60]+)\1`, "g");
const rel = (file) => path.relative(ROOT, file);

function resolveSpecifier(fromFile, specifier) {
  let base;
  if (specifier.startsWith("@/")) base = path.join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(fromFile), specifier);
  else return null;
  for (const candidate of [...EXTENSIONS.map((ext) => base + ext), ...EXTENSIONS.slice(1).map((ext) => path.join(base, `index${ext}`))]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return `${base} (unresolved)`;
}

/** Every import edge reachable from the entries: [importer, imported]. */
function edgesFrom(entries) {
  const seen = new Set();
  const edges = [];
  const queue = entries.map((entry) => path.join(ROOT, entry));
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!CODE.test(file) || file.endsWith(" (unresolved)")) continue;
    for (const match of fs.readFileSync(file, "utf8").matchAll(SPECIFIER)) {
      const target = resolveSpecifier(file, match[2]);
      if (!target) continue;
      edges.push([rel(file), rel(target)]);
      queue.push(target);
    }
  }
  return edges;
}

const STATIC_DOCUMENTS = new Set(["src/domain/commands/catalogue.json", "src/server/recipes/recipes.json"]);
const ADAPTER = "src/server/catalogue/static-adapter.ts";

function violations(entries) {
  return edgesFrom(entries)
    .filter(
      ([from, to]) =>
        to.endsWith(" (unresolved)") ||
        to.startsWith("src/server/contract/") ||
        (STATIC_DOCUMENTS.has(to) && from !== ADAPTER),
    )
    .map(([from, to]) => `${from} -> ${to}`);
}

const GENERATION_ENTRIES = [
  "src/app/api/generate/route.ts",
  "scripts/lib/plan.mjs",
  "scripts/qualify-model.mjs",
  "scripts/live-route-smoke.mjs",
  "scripts/runtime-smoke.mjs",
];

test("generation reads commands and recipes only through the catalogue repositories", () => {
  assert.deepEqual(violations(GENERATION_ENTRIES), []);
});

test("no file on the generation path names the static documents or the static contract (fs reads included)", () => {
  const files = new Set([...GENERATION_ENTRIES, ...edgesFrom(GENERATION_ENTRIES).map(([, to]) => to)]);
  const named = [...files]
    .filter((file) => CODE.test(file) && file !== ADAPTER && !file.endsWith(" (unresolved)"))
    .filter((file) => /catalogue\.json|recipes\.json|server\/contract\//.test(fs.readFileSync(path.join(ROOT, file), "utf8")))
    .filter((file) => file !== "src/server/contract/index.ts");
  assert.deepEqual(named, []);
});

test("the generation path does reach the repositories and the model registry", () => {
  const targets = new Set(edgesFrom(["src/app/api/generate/route.ts"]).map(([, to]) => to));
  for (const file of [ADAPTER, "src/server/models/index.ts", "src/server/models/registry.json", "src/server/generation/resolve.ts"]) {
    assert.ok(targets.has(file), `${file} not reachable from the route`);
  }
});

test("canary: the detector flags the static contract and a direct JSON import", () => {
  // src/server/contract/index.ts imports both static documents directly: it must be reported.
  const found = violations(["src/server/contract/index.ts"]);
  assert.ok(found.includes("src/server/contract/index.ts -> src/domain/commands/catalogue.json"), found.join("\n"));
  assert.ok(found.includes("src/server/contract/index.ts -> src/server/recipes/recipes.json"), found.join("\n"));
  // And an entry that imports src/server/contract is itself a violation.
  const scratch = path.join(ROOT, "tests", ".canary-generation-entry.ts");
  fs.writeFileSync(scratch, 'import { executionContract } from "../src/server/contract/index.ts";\nexport default executionContract;\n');
  try {
    assert.ok(violations(["tests/.canary-generation-entry.ts"]).includes("tests/.canary-generation-entry.ts -> src/server/contract/index.ts"));
  } finally {
    fs.rmSync(scratch);
  }
});
