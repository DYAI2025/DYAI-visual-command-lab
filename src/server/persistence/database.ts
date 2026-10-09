import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { CatalogueStoreError } from "./errors.ts";
import { MIGRATIONS, type Migration } from "./migrations.ts";

export type Database = DatabaseSync;

const checksum = (migration: Migration) => createHash("sha256").update(migration.sql).digest("hex");

/**
 * Opens the SQLite file. `create: false` (the runtime) refuses a path that does not exist instead of
 * silently creating an empty database; only the migrate command creates one.
 */
export function openDatabase(file: string, { create }: { create: boolean }): Database {
  if (!path.isAbsolute(file)) throw new CatalogueStoreError("CONFIG_INVALID", "database path must be absolute");
  if (!create && !fs.existsSync(file)) {
    throw new CatalogueStoreError("DATABASE_MISSING", "configured database file does not exist; run `npm run db:migrate`");
  }
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { enableForeignKeyConstraints: true });
  } catch (error) {
    // e.g. the path is a directory, or the file is not readable
    throw new CatalogueStoreError("DATABASE_UNREADABLE", `database cannot be opened (${(error as Error).message})`);
  }
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    const check = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    if (check?.quick_check !== "ok") throw new CatalogueStoreError("DATABASE_CORRUPT", "integrity check failed");
  } catch (error) {
    db.close();
    if (error instanceof CatalogueStoreError) throw error;
    throw new CatalogueStoreError("DATABASE_CORRUPT", `database cannot be read (${(error as Error).message})`);
  }
  return db;
}

/** Runs the transaction body between BEGIN IMMEDIATE and COMMIT; any throw rolls everything back. */
export function inTransaction<T>(db: Database, body: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = body();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const SCHEMA_SQL = "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name";
const MIGRATIONS_TABLE_SQL = "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT";

let referenceSchema: string | null = null;
/** sqlite_master of a database that ran exactly MIGRATIONS (built once, in memory). */
function expectedSchema(): string {
  if (referenceSchema === null) {
    const reference = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
    try {
      migrate(reference, () => "reference");
      referenceSchema = JSON.stringify(reference.prepare(SCHEMA_SQL).all());
    } finally {
      reference.close();
    }
  }
  return referenceSchema;
}

function recordedMigrations(db: Database): { id: string; checksum: string }[] | null {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!table) return null;
  return db.prepare("SELECT id, checksum FROM schema_migrations ORDER BY id").all() as { id: string; checksum: string }[];
}

function compare(db: Database): { pending: Migration[] } {
  const recorded = recordedMigrations(db) ?? [];
  const known = new Map(MIGRATIONS.map((migration) => [migration.id, migration]));
  for (const row of recorded) {
    const migration = known.get(row.id);
    if (!migration) throw new CatalogueStoreError("SCHEMA_DRIFT", `database has migration ${row.id} this code does not know`);
    if (checksum(migration) !== row.checksum) {
      throw new CatalogueStoreError("SCHEMA_DRIFT", `migration ${row.id} was applied with different content`);
    }
  }
  const applied = new Set(recorded.map((row) => row.id));
  return { pending: MIGRATIONS.filter((migration) => !applied.has(migration.id)) };
}

/** Applies every pending migration, each in its own transaction. Returns the ids it applied. */
export function migrate(db: Database, now: () => string = () => new Date().toISOString()): string[] {
  db.exec(MIGRATIONS_TABLE_SQL);
  const { pending } = compare(db);
  for (const migration of pending) {
    inTransaction(db, () => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)").run(migration.id, checksum(migration), now());
    });
  }
  return pending.map((migration) => migration.id);
}

/**
 * The runtime never migrates: a database that is behind or ahead of this code is refused, and so is
 * one whose actual tables, indexes and triggers differ from what the recorded migrations create
 * (a hand-altered schema or a partial restore).
 */
export function assertMigrated(db: Database): void {
  if (recordedMigrations(db) === null) {
    throw new CatalogueStoreError("SCHEMA_NOT_MIGRATED", "database has no schema; run `npm run db:migrate`");
  }
  const { pending } = compare(db);
  if (pending.length > 0) {
    throw new CatalogueStoreError("SCHEMA_NOT_MIGRATED", `pending migrations: ${pending.map((m) => m.id).join(", ")}`);
  }
  if (JSON.stringify(db.prepare(SCHEMA_SQL).all()) !== expectedSchema()) {
    throw new CatalogueStoreError("SCHEMA_DRIFT", "database schema objects differ from the recorded migrations");
  }
}

export function migrationStatus(db: Database): { id: string; checksum: string; applied: boolean }[] {
  const recorded = new Map((recordedMigrations(db) ?? []).map((row) => [row.id, row.checksum]));
  return MIGRATIONS.map((migration) => ({ id: migration.id, checksum: checksum(migration), applied: recorded.has(migration.id) }));
}
