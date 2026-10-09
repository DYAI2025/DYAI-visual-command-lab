import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { staticCommandRepository } from "../src/server/catalogue/static-adapter.ts";
import { readCatalogueStoreConfig } from "../src/server/catalogue/config.ts";
import { category, migratedDatabase, newCommand, newRecipe, openStore, seedBundle } from "./helpers/persistence.mjs";

// DYAI-39 durability: data written by one Node process is read back unchanged by another process,
// through the store and through the app's own runtime binding of the catalogue ports. Nothing is
// shared in memory between the writer and the readers.

const PROBE = "tests/fixtures/persistence-probe.mjs";

function probe(args, env = {}) {
  const result = spawnSync(process.execPath, [PROBE, ...args], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  if (lines.length === 0) throw new Error(`probe ${args.join(" ")} printed nothing (rc ${result.status}):\n${result.stderr}`);
  return { status: result.status, stderr: result.stderr, output: JSON.parse(lines.at(-1)) };
}

async function importedDatabase(t) {
  const fixture = migratedDatabase();
  t.after(fixture.cleanup);
  const store = openStore(fixture.file);
  await store.importSeed(seedBundle());
  store.close();
  return fixture;
}

test("a DRAFT command + recipe + category written by one process is read back unchanged by a new process", async (t) => {
  const { file } = await importedDatabase(t);
  const written = probe(["write", file]);
  assert.equal(written.status, 0, written.stderr);
  const read = probe(["read", file]);
  assert.equal(read.status, 0, read.stderr);
  assert.notEqual(read.output.pid, written.output.pid, "two different processes");

  const withoutPid = ({ pid, ...state }) => (assert.equal(typeof pid, "number"), state);
  const writtenState = withoutPid(written.output);
  const readState = withoutPid(read.output);
  assert.deepEqual(readState, writtenState, "everything the writer saw is what the new process reads");

  // and it is the input itself, not merely self-consistent
  assert.deepEqual(readState.command.command, newCommand());
  assert.equal(readState.command.lifecycle, "DRAFT");
  assert.deepEqual(readState.command.categoryIds, ["portraits"]);
  assert.equal(readState.command.recipeVersion, "0.1.0");
  assert.deepEqual(readState.recipe, newRecipe());
  assert.deepEqual(readState.categories, [{ ...category("portraits"), archived: false }]);
  assert.deepEqual(readState.history.map((entry) => entry.reason), ["create"]);
  assert.equal(readState.publicIds.length, 12);
  assert.equal(readState.publicIds.includes("sticker"), false);
  assert.ok(fs.statSync(file).size > 0);
});

test("the app runtime binding serves the durable store when configured, in a fresh process", async (t) => {
  const { file } = await importedDatabase(t);
  assert.equal(probe(["write", file]).status, 0);
  const env = { COMMAND_STORE_ADAPTER: "sqlite", DATABASE_URL: pathToFileURL(file).href };
  const runtime = probe(["runtime"], env);
  assert.equal(runtime.status, 0, runtime.stderr);
  const staticIds = (await staticCommandRepository.listPublicCommands()).map((command) => command.id);
  assert.deepEqual(runtime.output.publicIds, staticIds, "imported catalogue served in the same order");
  assert.equal(runtime.output.draftViaPublic, null, "DRAFT is not public");
  assert.equal(runtime.output.recipe.recipeId, "actionfigure-v1");
  assert.deepEqual(runtime.output.categories.map((c) => c.id), ["portraits"]);
  assert.deepEqual(runtime.output.draftViaAuthoring.command, newCommand());
  assert.equal(runtime.output.draftViaAuthoring.lifecycle, "DRAFT");

  // relative file: URL resolves against the working directory
  const relative = probe(["runtime"], { COMMAND_STORE_ADAPTER: "sqlite", DATABASE_URL: `file:${path.relative(process.cwd(), file)}` });
  assert.deepEqual(relative.output.publicIds, staticIds);
});

test("unset or static adapter keeps the bootstrap behaviour; authoring then fails closed", () => {
  for (const env of [{}, { COMMAND_STORE_ADAPTER: "static" }, { COMMAND_STORE_ADAPTER: "static", DATABASE_URL: "file:/nonexistent.db" }]) {
    const runtime = probe(["runtime"], env);
    assert.equal(runtime.status, 0, runtime.stderr);
    assert.equal(runtime.output.publicIds.length, 12);
    assert.equal(runtime.output.authoringError, "AUTHORING_UNAVAILABLE");
    assert.deepEqual(runtime.output.categories, []);
  }
});

test("a configured but broken durable store fails closed with a named error and never serves the static data", async (t) => {
  const { dir, file } = migratedDatabase();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const unmigrated = path.join(dir, "unmigrated.db");
  fs.writeFileSync(unmigrated, "");
  const cases = [
    [{ COMMAND_STORE_ADAPTER: "sqlite" }, "CONFIG_INVALID"],
    [{ COMMAND_STORE_ADAPTER: "sqlite", DATABASE_URL: "postgres://user:pw@db.example/vcl" }, "CONFIG_INVALID"],
    [{ COMMAND_STORE_ADAPTER: "sqlite", DATABASE_URL: "file::memory:" }, "CONFIG_INVALID"],
    [{ COMMAND_STORE_ADAPTER: "postgres", DATABASE_URL: pathToFileURL(file).href }, "CONFIG_INVALID"],
    [{ COMMAND_STORE_ADAPTER: "sqlite", DATABASE_URL: pathToFileURL(path.join(dir, "absent.db")).href }, "DATABASE_MISSING"],
    [{ COMMAND_STORE_ADAPTER: "sqlite", DATABASE_URL: pathToFileURL(unmigrated).href }, "SCHEMA_NOT_MIGRATED"],
  ];
  for (const [env, code] of cases) {
    const runtime = probe(["runtime"], env);
    assert.equal(runtime.status, 3, `${JSON.stringify(env)} must fail: ${JSON.stringify(runtime.output)}`);
    assert.deepEqual(runtime.output.error, { name: "CatalogueStoreError", code }, JSON.stringify(env));
    assert.equal(runtime.output.publicIds, undefined, "no fallback data served");
    assert.ok(!runtime.stderr.includes("pw@"), "the DATABASE_URL value is never echoed");
  }
  assert.equal(fs.existsSync(path.join(dir, "absent.db")), false, "the runtime never creates a database");
  // a migrated but empty store is a valid (empty) catalogue, not a fallback trigger
  const empty = probe(["runtime"], { COMMAND_STORE_ADAPTER: "sqlite", DATABASE_URL: pathToFileURL(file).href });
  assert.equal(empty.status, 0, empty.stderr);
  assert.deepEqual(empty.output.publicIds, []);
});

test("config parsing: adapter values and file URLs", () => {
  assert.deepEqual(readCatalogueStoreConfig({}), { adapter: "static" });
  assert.deepEqual(readCatalogueStoreConfig({ COMMAND_STORE_ADAPTER: " static " }), { adapter: "static" });
  assert.deepEqual(readCatalogueStoreConfig({ COMMAND_STORE_ADAPTER: "sqlite", DATABASE_URL: "file:///var/data/vcl.db" }), { adapter: "sqlite", file: "/var/data/vcl.db" });
  assert.deepEqual(readCatalogueStoreConfig({ COMMAND_STORE_ADAPTER: "sqlite", DATABASE_URL: "file:data/vcl.db" }), { adapter: "sqlite", file: path.resolve("data/vcl.db") });
  for (const env of [{ COMMAND_STORE_ADAPTER: "SQLite" }, { COMMAND_STORE_ADAPTER: "sqlite", DATABASE_URL: "file:" }, { COMMAND_STORE_ADAPTER: "sqlite", DATABASE_URL: "/abs/no-scheme.db" }]) {
    assert.throws(() => readCatalogueStoreConfig(env), (error) => error.code === "CONFIG_INVALID", JSON.stringify(env));
  }
});
