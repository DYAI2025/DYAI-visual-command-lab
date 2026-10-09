import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { assertMigrated, migrate, migrationStatus, openDatabase } from "../src/server/persistence/database.ts";
import { MIGRATIONS } from "../src/server/persistence/migrations.ts";
import { migratedDatabase, newCommand, newRecipe, openStore, rawQuery, rejects, seededStore } from "./helpers/persistence.mjs";

// DYAI-39: schema, migrations and the database-level backstops. Everything runs against real files.

const EXPECTED_TABLES = [
  "categories",
  "command_categories",
  "command_revisions",
  "command_slashes",
  "commands",
  "import_runs",
  "recipe_versions",
  "recipes",
  "schema_migrations",
];

test("migration creates exactly the authoring tables: no model, provider or generation table", (t) => {
  const { file, cleanup } = migratedDatabase();
  t.after(cleanup);
  const tables = rawQuery(file, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((row) => row.name);
  assert.deepEqual(tables, EXPECTED_TABLES);
  const columns = tables.flatMap((table) => rawQuery(file, `SELECT name FROM pragma_table_info('${table}')`).map((row) => `${table}.${row.name}`));
  assert.deepEqual(columns.filter((column) => /model|provider|secret|token|api_?key|image_?(bytes|data)|base64/i.test(column)), []);
  for (const table of tables.filter((name) => name !== "schema_migrations")) {
    const sql = rawQuery(file, "SELECT sql FROM sqlite_master WHERE name = ?", table)[0].sql;
    assert.match(sql, /\)\s*STRICT\s*$/, `${table} is a STRICT table`);
  }
});

test("migrate is deterministic and idempotent: same checksums, second run applies nothing", (t) => {
  const { file, cleanup } = migratedDatabase();
  t.after(cleanup);
  const db = openDatabase(file, { create: false });
  t.after(() => db.close());
  assert.deepEqual(migrate(db), []);
  assert.deepEqual(
    migrationStatus(db).map(({ id, applied }) => ({ id, applied })),
    MIGRATIONS.map(({ id }) => ({ id, applied: true })),
  );
  const { file: other, cleanup: cleanupOther } = migratedDatabase();
  t.after(cleanupOther);
  const schema = (f) => rawQuery(f, "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name");
  assert.deepEqual(schema(file), schema(other));
  assert.deepEqual(rawQuery(file, "SELECT id, checksum FROM schema_migrations"), rawQuery(other, "SELECT id, checksum FROM schema_migrations"));
});

test("the runtime refuses a missing file, an empty file, a corrupt file and schema drift", async (t) => {
  const { dir, file, cleanup } = migratedDatabase();
  t.after(cleanup);
  await rejects(Promise.resolve().then(() => openStore(path.join(dir, "absent.db"))), "DATABASE_MISSING");
  assert.equal(fs.existsSync(path.join(dir, "absent.db")), false, "opening must not create the file");

  const empty = path.join(dir, "empty.db");
  new DatabaseSync(empty).close();
  await rejects(Promise.resolve().then(() => openStore(empty)), "SCHEMA_NOT_MIGRATED");

  const corrupt = path.join(dir, "corrupt.db");
  fs.writeFileSync(corrupt, "this is not a database file ".repeat(200));
  await rejects(Promise.resolve().then(() => openStore(corrupt)), "DATABASE_CORRUPT");

  const tampered = path.join(dir, "tampered.db");
  fs.copyFileSync(file, tampered);
  const raw = new DatabaseSync(tampered);
  raw.prepare("UPDATE schema_migrations SET checksum = 'x' WHERE id = ?").run(MIGRATIONS[0].id);
  raw.close();
  await rejects(Promise.resolve().then(() => openStore(tampered)), "SCHEMA_DRIFT");

  const ahead = path.join(dir, "ahead.db");
  fs.copyFileSync(file, ahead);
  const rawAhead = new DatabaseSync(ahead);
  rawAhead.prepare("INSERT INTO schema_migrations (id, checksum, applied_at) VALUES ('9999_future', 'f', 'now')").run();
  rawAhead.close();
  await rejects(Promise.resolve().then(() => openStore(ahead)), "SCHEMA_DRIFT");

  const db = openDatabase(file, { create: false });
  assert.doesNotThrow(() => assertMigrated(db));
  db.close();
});

test("database backstops hold even when the repository is bypassed with raw SQL", async (t) => {
  const { file, store, cleanup } = await seededStore();
  t.after(() => {
    store.close();
    cleanup();
  });
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: true });
  t.after(() => db.close());
  const row = db.prepare("SELECT * FROM commands WHERE id = 'mindmap'").get();
  const expectFail = (sql, pattern, ...params) => assert.throws(() => db.prepare(sql).run(...params), pattern, sql);

  // duplicate canonical slash / id
  expectFail(
    `INSERT INTO commands (id, canonical_slash, lane, maturity, recipe_id, name_en, description_en, name_de, description_de, job_en, job_de, document, lifecycle, origin, sort_key, revision, created_at, updated_at)
     SELECT id, canonical_slash, lane, maturity, recipe_id, name_en, description_en, name_de, description_de, job_en, job_de, document, 'DRAFT', 'authored', 999, 1, 'a', 'a' FROM commands WHERE id = 'mindmap'`,
    /UNIQUE constraint failed: commands\.(id|canonical_slash)/,
  );
  // alias or canonical slash claimed twice
  expectFail("INSERT INTO command_slashes (slash, command_id, kind) VALUES ('/mindmap', 'bricktoy', 'alias')", /UNIQUE constraint failed: command_slashes\.slash/);
  // invalid lifecycle value
  expectFail("UPDATE commands SET lifecycle = 'PUBLISHED', revision = revision + 1 WHERE id = 'mindmap'", /lifecycle transition not allowed|CHECK constraint failed/);
  expectFail("INSERT INTO command_revisions SELECT command_id, 99, 'PUBLISHED', document, category_ids, recipe_version, reason, recorded_at FROM command_revisions WHERE command_id = 'mindmap'", /CHECK constraint failed/);
  // forbidden transition (ACTIVE -> DRAFT skips TESTING)
  expectFail("UPDATE commands SET lifecycle = 'DRAFT', revision = revision + 1 WHERE id = 'mindmap'", /lifecycle transition not allowed/);
  // destructive removal
  expectFail("DELETE FROM commands WHERE id = 'mindmap'", /commands are archived, never deleted/);
  expectFail("DELETE FROM command_revisions WHERE command_id = 'mindmap'", /append-only/);
  expectFail("UPDATE command_revisions SET lifecycle = 'DRAFT' WHERE command_id = 'mindmap'", /append-only/);
  expectFail("UPDATE recipe_versions SET document = document WHERE recipe_id = 'mindmap-v1'", /immutable/);
  expectFail("DELETE FROM recipe_versions WHERE recipe_id = 'mindmap-v1'", /never deleted/);
  // dangling recipe relation
  expectFail("UPDATE commands SET recipe_id = 'ghost-v1', document = json_set(document, '$.recipeId', 'ghost-v1'), revision = revision + 1 WHERE id = 'mindmap'", /FOREIGN KEY constraint failed/);
  // projection columns cannot drift from the stored contract document
  expectFail("UPDATE commands SET name_de = 'Anders', revision = revision + 1 WHERE id = 'mindmap'", /CHECK constraint failed/);
  expectFail("UPDATE commands SET lane = 'polish', revision = revision + 1 WHERE id = 'mindmap'", /CHECK constraint failed/);
  // blank bilingual metadata
  expectFail(
    "UPDATE commands SET name_de = ' ', document = json_set(document, '$.display.de.name', ' '), revision = revision + 1 WHERE id = 'mindmap'",
    /CHECK constraint failed/,
  );
  // writes skip no revision; authored rows cannot be inserted ACTIVE
  expectFail("UPDATE commands SET updated_at = 'x' WHERE id = 'mindmap'", /exactly one new revision/);
  expectFail(
    `INSERT INTO commands (id, canonical_slash, lane, maturity, recipe_id, name_en, description_en, name_de, description_de, job_en, job_de, document, lifecycle, origin, sort_key, revision, created_at, updated_at)
     VALUES ('x1', '/x1', 'play', 'candidate', NULL, 'n', 'd', 'n', 'd', 'j', 'j', '{"id":"x1","canonicalSlash":"/x1","lane":"play","maturity":"candidate","recipeId":null,"display":{"en":{"name":"n","description":"d"},"de":{"name":"n","description":"d"}},"job":{"en":"j","de":"j"}}', 'ACTIVE', 'authored', 998, 1, 'a', 'a')`,
    /authored commands start as DRAFT/,
  );
  assert.deepEqual(db.prepare("SELECT * FROM commands WHERE id = 'mindmap'").get(), row, "the row is unchanged after every refused write");
});

test("an unopenable path and a hand-altered schema fail closed with availability codes", async (t) => {
  const { dir, file, cleanup } = migratedDatabase();
  t.after(cleanup);
  // a directory where the database file should be
  const asDirectory = path.join(dir, "dir.db");
  fs.mkdirSync(asDirectory);
  const unreadable = await rejects(Promise.resolve().then(() => openStore(asDirectory)), "DATABASE_UNREADABLE");
  assert.equal(unreadable.unavailable, true);

  // checksums intact, but a trigger was dropped by hand: the schema no longer matches its migrations
  const altered = path.join(dir, "altered.db");
  fs.copyFileSync(file, altered);
  const raw = new DatabaseSync(altered);
  raw.exec("DROP TRIGGER commands_kept");
  raw.close();
  await rejects(Promise.resolve().then(() => openStore(altered)), "SCHEMA_DRIFT");
});

test("a SQLite failure at query time (read or write path) surfaces as DATABASE_UNREADABLE", async (t) => {
  const { file, store, cleanup } = await seededStore();
  t.after(() => {
    store.close();
    cleanup();
  });
  // another process breaks the database after this store opened it
  const raw = new DatabaseSync(file);
  raw.exec("DROP INDEX commands_lifecycle; ALTER TABLE command_slashes RENAME TO command_slashes_gone;");
  raw.close();
  const error = await rejects(store.commands.findBySlash("/mindmap"), "DATABASE_UNREADABLE");
  assert.equal(error.unavailable, true);
  await rejects(store.authoring.createDraftCommand({ command: newCommand(), recipe: newRecipe() }), "DATABASE_UNREADABLE");
  assert.equal((await store.authoring.getCommand("mindmap")).lifecycle, "ACTIVE", "tables that still exist keep serving reads");
});

test("db:status reports an unmigrated database instead of crashing", (t) => {
  const { dir, cleanup } = migratedDatabase();
  t.after(cleanup);
  const empty = path.join(dir, "empty.db");
  new DatabaseSync(empty).close();
  const result = spawnSync(process.execPath, ["scripts/db.mjs", "status", "--database", empty], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert.equal(status.migrated, false);
  assert.deepEqual(status.migrations.map((m) => m.applied), MIGRATIONS.map(() => false));
});
