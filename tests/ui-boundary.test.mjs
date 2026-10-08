import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

const ROOT = fs.realpathSync(".");
const SRC = path.join(ROOT, "src");
const CODE = /\.(?:[cm]?[jt]sx?)$/;
const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];

const filesUnder = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full);
    return CODE.test(entry.name) ? [full] : [];
  });

// Static imports (incl. multi-line and side-effect), re-exports, dynamic import() and require(),
// with single, double or backtick quotes and comments before the specifier.
const GAP = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*`;
const SPECIFIER = new RegExp(String.raw`(?:\bfrom${GAP}|\bimport${GAP}(?:\(${GAP})?|\brequire${GAP}\(${GAP})(["'\x60])([^"'\x60]+)\1`, "g");
const CALL = new RegExp(String.raw`\b(?:import|require)\s*\(\s*`, "g");
const specifiersOf = (source) => [...source.matchAll(SPECIFIER)].map((match) => match[2]);

/** Same length as the source, with comments and string/template contents replaced by spaces. */
function blankLiteralsAndComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|(["'\x60])(?:\\[\s\S]|(?!\1)[^\\])*\1/g, (match, quote) =>
    quote ? quote + " ".repeat(match.length - 2) + quote : match.replace(/[^\n]/g, " "),
  );
}

/**
 * A dynamic import()/require() whose argument is not one plain string literal, or any
 * require.context(), cannot be checked and counts as a violation. Calls are found in code only:
 * text inside strings and comments is ignored.
 */
function hasUncheckableCall(source) {
  const code = blankLiteralsAndComments(source);
  if (/\brequire\s*\.\s*context\b/.test(code)) return true;
  for (const match of code.matchAll(CALL)) {
    const rest = source.slice(match.index + match[0].length).replace(new RegExp(`^${GAP}`), "");
    if (!/^(["'\x60])[^"'\x60$]*\1\s*[),]/.test(rest)) return true;
  }
  return false;
}

function resolveSpecifier(fromFile, specifier) {
  let base;
  if (specifier.startsWith("@/")) base = path.join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(fromFile), specifier);
  else if (path.isAbsolute(specifier)) base = specifier;
  else return null; // package import
  for (const candidate of [...EXTENSIONS.map((ext) => base + ext), ...EXTENSIONS.slice(1).map((ext) => path.join(base, `index${ext}`))]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return `${base} (unresolved)`;
}

/** Every repository file reachable through imports from the entry files. */
function reachableFrom(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!CODE.test(file) || file.endsWith(" (unresolved)")) continue;
    const source = fs.readFileSync(file, "utf8");
    if (hasUncheckableCall(source)) seen.add(`${file} (uncheckable dynamic import)`);
    for (const specifier of specifiersOf(source)) {
      const target = resolveSpecifier(file, specifier);
      if (target) queue.push(target);
    }
  }
  return [...seen];
}

const rel = (file) => path.relative(ROOT, file);

// Dependency rule: UI -> catalogue metadata only. Nothing reachable from UI may be server code,
// the recipe/model documents or their schemas, or the cross-document validator. Case-insensitive,
// because macOS resolves "@/Server/..." to src/server.
const FORBIDDEN_FOR_UI = [
  /^src\/server\//i,
  /recipe-book\.schema\.json$/i,
  /model-registry\.schema\.json$/i,
  /^src\/domain\/contract\/(?:validate-contract|contract)\.ts$/i,
  / \(unresolved\)$/,
  / \(uncheckable dynamic import\)$/,
];

function uiViolations(entries) {
  const reachable = reachableFrom(entries).map(rel).filter((file) => FORBIDDEN_FOR_UI.some((rule) => rule.test(file)));
  // UI files may enter src/domain only through the public catalogue module.
  const direct = entries.flatMap((entry) =>
    specifiersOf(fs.readFileSync(entry, "utf8"))
      .map((specifier) => resolveSpecifier(entry, specifier))
      .filter((target) => target && /^src\/domain\//i.test(rel(target)) && rel(target) !== "src/domain/commands/index.ts")
      .map((target) => `${rel(entry)} -> ${rel(target)} (bypasses @/domain/commands)`),
  );
  return [...reachable, ...direct];
}

const UI_ENTRIES = filesUnder(path.join(SRC, "app", "[locale]"));

test("nothing reachable from the UI is server code or recipe/model data", () => {
  assert.ok(UI_ENTRIES.length > 0);
  const reachable = reachableFrom(UI_ENTRIES).map(rel);
  assert.ok(reachable.includes("src/domain/commands/catalogue.json"), "scan must reach the catalogue");
  assert.deepEqual(uiViolations(UI_ENTRIES), []);
});

test("domain code never imports server modules", () => {
  const violations = reachableFrom(filesUnder(path.join(SRC, "domain")))
    .map(rel)
    .filter((file) => /^src\/server\//i.test(file) || file.endsWith(" (uncheckable dynamic import)"));
  assert.deepEqual(violations, []);
});

function scanCanary(source, extension) {
  const dir = fs.mkdtempSync(path.join(ROOT, ".boundary-canary-"));
  try {
    const file = path.join(dir, `page${extension}`);
    fs.writeFileSync(file, `${source}\nexport default function Page() { return null; }\n`);
    return uiViolations([file]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Canaries: each import form must be seen and must produce a violation.
const CANARY_FORMS = {
  static: 'import { executionContract } from "@/server/contract";',
  multiline: 'import {\n  executionContract,\n} from "@/server/contract";',
  sideEffect: 'import "@/server/contract";',
  reexport: 'export { executionContract } from "@/server/contract";',
  dynamic: 'const mod = await import("@/server/contract");',
  template: "const mod = await import(`@/server/contract`);",
  require: 'const mod = require("@/server/recipes/recipes.json");',
  relativeContract: 'import { createContract } from "../src/domain/contract/contract.ts";',
  commentedDynamic: 'const mod = await import(/* webpackChunkName: "x" */ "@/server/contract");',
  multilineDynamic: 'const mod = await import(\n  // server\n  "@/server/contract"\n);',
  interpolatedTemplate: 'const mod = await import(`@/server/${"contract"}/index.ts`);',
  variableSpecifier: 'const target = "@/server/contract";\nconst mod = await import(target);',
  concatenatedSpecifier: 'const mod = await import("@/domain/commands" + "/../../server/contract/index.ts");',
  concatenatedRequire: 'const mod = require("@/domain/commands" + "/../../server/recipes/recipes.json");',
  requireContext: 'const ctx = require.context("../src/server", true, /\\.json$/);',
  upperCaseAlias: 'import registry from "@/Server/models/registry.json";',
  absolutePath: `import { executionContract } from "${path.join(SRC, "server", "contract", "index.ts")}";`,
  domainBypass: 'import { validateAgainstSchema } from "@/domain/contract/json-schema";',
};

for (const [form, source] of Object.entries(CANARY_FORMS)) {
  for (const extension of [".tsx", ".js"]) {
    test(`boundary scan catches a ${form} import in a ${extension} file (canary)`, () => {
      assert.notDeepEqual(scanCanary(source, extension), [], `${form} import was not detected`);
    });
  }
}

// Negative canaries: valid UI code must not be flagged.
const VALID_FORMS = {
  catalogueImport: 'import { commandCatalogue } from "@/domain/commands";',
  wordsInStrings: 'export const hint = "Some commands require (at least) one photo; import (later) more.";',
  wordsInComments: "// We may import (lazily) or require (sync) things later.\nexport const x = 1;",
  packageDynamicImport: 'export const load = () => import("react");',
};

for (const [form, source] of Object.entries(VALID_FORMS)) {
  test(`boundary scan accepts valid UI code: ${form}`, () => {
    assert.deepEqual(scanCanary(source, ".tsx"), []);
  });
}
