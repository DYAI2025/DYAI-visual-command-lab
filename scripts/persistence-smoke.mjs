// Persistence runtime smoke (DYAI-39). Drives the real boundary end to end with separate processes:
// the operator CLI migrates and imports a temp database, a separate process authors a DRAFT command,
// and the production build (`next start`) serves the catalogue from that database. Lifecycle changes
// made by other processes while the server runs show up on the next request: the database, not a JSON
// file, is the runtime source. A configured but missing database fails closed. Needs `npm run build`.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { startApp } from "./lib/next-app.mjs";

if (!fs.existsSync(".next/BUILD_ID")) {
  console.error("persistence-smoke: no production build (.next/BUILD_ID); run `npm run build` first");
  process.exit(1);
}

const SEED_FILES = ["src/domain/commands/catalogue.json", "src/server/recipes/recipes.json"];
const DRAFT_TEXT = "Turns your photo into a die-cut sticker."; // tests/helpers/persistence.mjs newCommand()
const seedDigest = () => SEED_FILES.map((file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex")).join(":");
const seedBefore = seedDigest();
const catalogue = JSON.parse(fs.readFileSync(SEED_FILES[0], "utf8"));
const escapeHtml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dyai39-smoke-"));
const file = path.join(dir, "catalogue.db");
const results = [];
const check = (name, condition, detail = "") => results.push({ name, ok: Boolean(condition), detail });

function run(args) {
  const result = spawnSync(process.execPath, args, { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  const last = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  let json = null;
  try {
    json = last ? JSON.parse(last) : null;
  } catch {
    // keep null
  }
  return { status: result.status, json, stderr: result.stderr };
}

async function page(app, locale = "en") {
  const response = await fetch(`${app.base}/${locale}`);
  return { status: response.status, html: await response.text() };
}

const servesAll = (html) => catalogue.commands.every((command) => html.includes(escapeHtml(command.display.en.name)));

try {
  const migrated = run(["scripts/db.mjs", "migrate", "--database", file]);
  check("cli migrate: creates and migrates the database", migrated.status === 0 && migrated.json?.applied?.length === 1, JSON.stringify(migrated));
  const imported = run(["scripts/db.mjs", "import-vc01", "--database", file]);
  check("cli import-vc01: 12 commands and 3 recipes inserted", imported.status === 0 && imported.json?.commandsInserted === 12 && imported.json?.recipesInserted === 3, JSON.stringify(imported.json));
  const again = run(["scripts/db.mjs", "import-vc01", "--database", file]);
  check("cli import-vc01 rerun: idempotent (12/3 unchanged, same digest)", again.status === 0 && again.json?.commandsUnchanged === 12 && again.json?.recipesUnchanged === 3 && again.json?.sourceDigest === imported.json?.sourceDigest, JSON.stringify(again.json));
  const written = run(["tests/fixtures/persistence-probe.mjs", "write", file]);
  check("separate process authors a DRAFT command + recipe + category", written.status === 0 && written.json?.command?.lifecycle === "DRAFT", written.stderr.slice(0, 300));

  const env = { COMMAND_STORE_ADAPTER: "sqlite", DATABASE_URL: pathToFileURL(file).href };
  const app = await startApp(env);
  try {
    let en = await page(app);
    check("sqlite runtime: /en serves all 12 imported commands from the database", en.status === 200 && servesAll(en.html), `status ${en.status}`);
    check("sqlite runtime: the DRAFT command is not served", !en.html.includes(DRAFT_TEXT));
    const de = await page(app, "de");
    check("sqlite runtime: /de serves the German names", de.status === 200 && catalogue.commands.every((c) => de.html.includes(escapeHtml(c.display.de.name))), `status ${de.status}`);

    const testing = run(["tests/fixtures/persistence-probe.mjs", "transition", file, "TESTING"]);
    en = await page(app);
    check("TESTING (written by another process) stays operator-only", testing.json?.lifecycle === "TESTING" && !en.html.includes(DRAFT_TEXT));
    const active = run(["tests/fixtures/persistence-probe.mjs", "transition", file, "ACTIVE"]);
    en = await page(app);
    check("ACTIVE (written by another process) is served by the running server without any JSON edit", active.json?.lifecycle === "ACTIVE" && en.html.includes(DRAFT_TEXT), JSON.stringify(active.json));
    const archived = run(["tests/fixtures/persistence-probe.mjs", "transition", file, "ARCHIVED"]);
    en = await page(app);
    check("ARCHIVED disappears from the served catalogue again", archived.json?.lifecycle === "ARCHIVED" && !en.html.includes(DRAFT_TEXT) && servesAll(en.html));
  } finally {
    await app.stop();
  }
  const history = run(["tests/fixtures/persistence-probe.mjs", "read", file]);
  check("archived command keeps its record and 4-revision history", history.json?.command?.lifecycle === "ARCHIVED" && history.json?.history?.map((h) => h.lifecycle).join(">") === "DRAFT>TESTING>ACTIVE>ARCHIVED", JSON.stringify(history.json?.history?.map((h) => h.lifecycle)));

  const missing = path.join(dir, "absent.db");
  const broken = await startApp({ COMMAND_STORE_ADAPTER: "sqlite", DATABASE_URL: pathToFileURL(missing).href });
  try {
    const response = await page(broken);
    check("missing database: /en fails (no fallback to the static catalogue)", response.status >= 500 && !servesAll(response.html), `status ${response.status}`);
    const log = broken.output.join("");
    check("missing database: server log names CatalogueStoreError DATABASE_MISSING", /DATABASE_MISSING/.test(log), log.slice(-400));
    check("missing database: health route still answers (process up, catalogue down)", (await fetch(`${broken.base}/api/health`)).ok);
  } finally {
    await broken.stop();
  }
  check("missing database: the runtime did not create a file", !fs.existsSync(missing));

  const fallback = await startApp({});
  try {
    const response = await page(fallback);
    check("default (static) runtime unchanged: /en serves the 12 bootstrap commands", response.status === 200 && servesAll(response.html) && !response.html.includes(DRAFT_TEXT));
  } finally {
    await fallback.stop();
  }
  check("seed JSON files untouched by the whole run", seedDigest() === seedBefore);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}${result.ok || !result.detail ? "" : `\n      ${String(result.detail).slice(0, 400)}`}`);
const failed = results.filter((result) => !result.ok).length;
console.log(`persistence-smoke: ${results.length - failed}/${results.length} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
