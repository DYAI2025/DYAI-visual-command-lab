import { createHash } from "node:crypto";

import { matchCommandSlash } from "../../domain/contract/contract.ts";
import { validateContract } from "../../domain/contract/validate-contract.ts";
import type { CommandRecord, ContractIssue, ModelRegistry, Recipe } from "../../domain/contract/types.ts";
import type { CategoryRecord, CategoryRepository, CommandRepository, RecipeRepository } from "../catalogue/port.ts";
import type { ModelRegistryPort } from "../models/port.ts";
import {
  AUTHORING_LIFECYCLES,
  type AuthoredCommand,
  type AuthoringLifecycle,
  type AuthoringRepository,
  type CategoryInput,
  type CommandQuery,
  type CommandRevision,
  type RecipeVersionResult,
} from "../authoring/port.ts";
import { canonicalJson } from "./canonical-json.ts";
import { assertNoForbiddenContent } from "./content-guard.ts";
import { assertMigrated, inTransaction, openDatabase, type Database } from "./database.ts";
import { CatalogueStoreError } from "./errors.ts";
import { LIFECYCLE_TRANSITIONS } from "./migrations.ts";

// Durable Command/Recipe/Category store (DYAI-39) on SQLite via node:sqlite. One instance owns one
// connection. Reads for the public repositories see ACTIVE commands only; the authoring repository
// sees every lifecycle. Model Capability is read from the separate registry port for validation and
// never written here.

export interface SeedBundle {
  catalogue: unknown;
  recipes: unknown;
}

export interface SeedImportReport {
  commandsInserted: number;
  commandsUnchanged: number;
  recipesInserted: number;
  recipesUnchanged: number;
  sourceDigest: string;
}

export interface SqliteCatalogueStore {
  commands: CommandRepository;
  recipes: RecipeRepository;
  categories: CategoryRepository;
  authoring: AuthoringRepository;
  /** Deterministic, all-or-nothing import of a contract-valid catalogue + recipe book (VC-01 seed). */
  importSeed(bundle: SeedBundle, options?: { source?: string }): Promise<SeedImportReport>;
  close(): void;
}

export interface SqliteStoreOptions {
  /** Absolute path of an existing, fully migrated database file. */
  file: string;
  models: ModelRegistryPort;
  now?: () => string;
  /** How long a statement waits for another connection's lock (default 5000 ms). */
  busyTimeoutMs?: number;
}

interface CommandRow {
  id: string;
  lifecycle: AuthoringLifecycle;
  document: string;
  recipe_id: string | null;
  origin: AuthoredCommand["origin"];
  revision: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface CategoryRow {
  id: string;
  slug: string;
  name_en: string;
  description_en: string;
  name_de: string;
  description_de: string;
  archived: number;
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

const parse = <T>(json: string): T => JSON.parse(json) as T;

/** Ids and versions at the authoring boundary are non-empty strings; anything else is an input error. */
function requireText(...values: unknown[]): void {
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) {
      throw new CatalogueStoreError("VALIDATION_FAILED", `expected a non-empty string id, got ${value === null ? "null" : typeof value}`);
    }
  }
}
const issuesText = (issues: readonly ContractIssue[]) => issues.map((issue) => `${issue.code} ${issue.path}`).join("; ");

function toCategory(row: CategoryRow): CategoryRecord {
  return {
    id: row.id,
    slug: row.slug,
    display: {
      en: { name: row.name_en, description: row.description_en },
      de: { name: row.name_de, description: row.description_de },
    },
    archived: row.archived === 1,
  };
}

function isConstraintError(error: unknown, pattern: RegExp): boolean {
  return error instanceof Error && pattern.test(error.message);
}

const SQLITE_CONSTRAINT = 19;
const SQLITE_BUSY = 5;

/**
 * Every repository call surfaces a CatalogueStoreError. A database-level rule that refused a write
 * (constraint or trigger) is CONSTRAINT_VIOLATION; any other SQLite failure at query time (a dropped
 * table, I/O or corruption found after open) means the store cannot serve: DATABASE_UNREADABLE, which
 * callers treat like the open-time availability errors (the route answers 503, never falls back).
 */
function storeError(error: unknown): unknown {
  if (error instanceof CatalogueStoreError) return error;
  const sqlite = error as { code?: string; errcode?: number; message?: string };
  // a value SQLite cannot bind (e.g. an id that is not a string): the caller's input, not the store
  if (sqlite?.code === "ERR_INVALID_ARG_TYPE") return new CatalogueStoreError("VALIDATION_FAILED", sqlite.message ?? "invalid argument");
  // a structurally broken input (e.g. command: null) fails while being read: the caller's input, refused
  if (error instanceof TypeError) return new CatalogueStoreError("VALIDATION_FAILED", `malformed input (${error.message})`);
  if (sqlite?.code !== "ERR_SQLITE_ERROR") return error;
  const primary = typeof sqlite.errcode === "number" ? sqlite.errcode & 0xff : -1;
  if (primary === SQLITE_CONSTRAINT) return new CatalogueStoreError("CONSTRAINT_VIOLATION", sqlite.message ?? "constraint failed");
  // another connection held the lock past busy_timeout: transient, retryable
  if (primary === SQLITE_BUSY) return new CatalogueStoreError("DATABASE_BUSY", sqlite.message ?? "database is locked");
  return new CatalogueStoreError("DATABASE_UNREADABLE", sqlite.message ?? "query failed");
}

/** Wraps every async method of a repository object so raw SQLite errors become CatalogueStoreErrors. */
function guarded<T extends object>(repository: T): T {
  const wrapped: Record<string, unknown> = {};
  for (const [name, method] of Object.entries(repository)) {
    wrapped[name] = async (...args: unknown[]) => {
      try {
        return await (method as (...a: unknown[]) => Promise<unknown>).apply(repository, args);
      } catch (error) {
        throw storeError(error);
      }
    };
  }
  return wrapped as T;
}

export function openSqliteCatalogueStore(options: SqliteStoreOptions): SqliteCatalogueStore {
  const db: Database = openDatabase(options.file, { create: false, busyTimeoutMs: options.busyTimeoutMs });
  try {
    assertMigrated(db);
  } catch (error) {
    db.close();
    throw storeError(error);
  }
  const now = options.now ?? (() => new Date().toISOString());
  const registry = async (): Promise<ModelRegistry> => options.models.load();

  // ---------- row helpers (synchronous; callers hold a transaction where it matters) ----------

  const commandRow = (id: string) =>
    db.prepare("SELECT id, lifecycle, document, recipe_id, origin, revision, created_at, updated_at, archived_at FROM commands WHERE id = ?").get(id) as
      | CommandRow
      | undefined;
  const categoryIdsOf = (id: string) =>
    (db.prepare("SELECT category_id FROM command_categories WHERE command_id = ? ORDER BY category_id").all(id) as { category_id: string }[]).map(
      (row) => row.category_id,
    );
  const currentVersion = (recipeId: string | null) =>
    recipeId === null
      ? null
      : ((db.prepare("SELECT current_version FROM recipes WHERE recipe_id = ?").get(recipeId) as { current_version: string } | undefined)
          ?.current_version ?? null);
  const recipeDocument = (recipeId: string, version: string) =>
    (db.prepare("SELECT document FROM recipe_versions WHERE recipe_id = ? AND version = ?").get(recipeId, version) as { document: string } | undefined)
      ?.document ?? null;
  const currentRecipe = (recipeId: string): Recipe | null => {
    const version = currentVersion(recipeId);
    const document = version === null ? null : recipeDocument(recipeId, version);
    return document === null ? null : parse<Recipe>(document);
  };

  /** The recipe version recorded with the command's latest revision (what an archived command last ran). */
  const recordedRecipeVersion = (id: string) =>
    (db.prepare("SELECT recipe_version FROM command_revisions WHERE command_id = ? ORDER BY revision DESC LIMIT 1").get(id) as
      | { recipe_version: string | null }
      | undefined)?.recipe_version ?? null;

  /** Several statements read as one snapshot (another process may commit in between otherwise). */
  function readConsistent<T>(body: () => T): T {
    if (db.isTransaction) return body();
    db.exec("BEGIN");
    try {
      return body();
    } finally {
      db.exec("COMMIT");
    }
  }

  const toAuthored = (row: CommandRow): AuthoredCommand => ({
    command: parse<CommandRecord>(row.document),
    lifecycle: row.lifecycle,
    categoryIds: categoryIdsOf(row.id),
    // An archived command is frozen: it reports the version it was archived with, not today's current one.
    recipeVersion: row.lifecycle === "ARCHIVED" ? recordedRecipeVersion(row.id) : currentVersion(row.recipe_id),
    origin: row.origin,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  });

  const appendRevision = (id: string, reason: CommandRevision["reason"], at: string) => {
    const row = commandRow(id)!;
    db.prepare(
      "INSERT INTO command_revisions (command_id, revision, lifecycle, document, category_ids, recipe_version, reason, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, row.revision, row.lifecycle, row.document, JSON.stringify(categoryIdsOf(id)), currentVersion(row.recipe_id), reason, at);
  };

  // ---------- validation ----------

  /**
   * The contract validator over a one-document bundle. The catalogue and recipe-book schemas require at
   * least one entry; an empty placeholder document is not the subject under test, so exactly that
   * minItems issue is dropped for it. Registry issues still count: an invalid registry fails closed.
   */
  function validateSingle(commands: CommandRecord[], recipes: Recipe[], models: ModelRegistry): ContractIssue[] {
    return validateContract({
      catalogue: { schemaVersion: "1.0.0", commands },
      recipes: { schemaVersion: "1.0.0", recipes },
      models,
    }).filter(
      (issue) =>
        !(issue.code === "SCHEMA_MIN_ITEMS" && ((issue.path === "/commands" && commands.length === 0) || (issue.path === "/recipes" && recipes.length === 0))),
    );
  }

  /** The command against the DYAI-31 contract, with its current recipe and the separate registry. */
  function validateCommand(command: CommandRecord, recipe: Recipe | null, models: ModelRegistry) {
    const issues = validateSingle([command], recipe ? [recipe] : [], models);
    if (issues.length > 0) throw new CatalogueStoreError("VALIDATION_FAILED", `command ${command.id ?? "?"}: ${issuesText(issues)}`, { issues });
    // The schema requires non-empty strings; persisted DE/EN metadata must also be more than whitespace.
    const blank = (
      [
        ["/display/en/name", command.display.en.name],
        ["/display/en/description", command.display.en.description],
        ["/display/de/name", command.display.de.name],
        ["/display/de/description", command.display.de.description],
        ["/job/en", command.job.en],
        ["/job/de", command.job.de],
      ] as const
    ).filter(([, value]) => value.trim().length === 0);
    if (blank.length > 0) {
      throw new CatalogueStoreError("VALIDATION_FAILED", `command ${command.id}: blank bilingual metadata at ${blank.map(([at]) => at).join(", ")}`);
    }
  }

  /** The recipe document on its own (schema, recipe rules, model references resolve in the registry). */
  function validateRecipe(recipe: Recipe, models: ModelRegistry) {
    const issues = validateSingle([], [recipe], models);
    if (issues.length > 0) throw new CatalogueStoreError("VALIDATION_FAILED", `recipe ${recipe.recipeId ?? "?"}: ${issuesText(issues)}`, { issues });
  }

  /** Every slash of the command must be free, or already belong to the same command. */
  function assertSlashesFree(command: CommandRecord) {
    for (const slash of [command.canonicalSlash, ...command.aliases.map((alias) => alias.slash)]) {
      const owner = db.prepare("SELECT command_id FROM command_slashes WHERE slash = ?").get(slash) as { command_id: string } | undefined;
      if (owner && owner.command_id !== command.id) {
        throw new CatalogueStoreError("SLASH_CONFLICT", `${slash} already belongs to command ${owner.command_id}`);
      }
    }
  }

  /** Categories must exist; an archived one may be kept where it is already assigned, never newly assigned. */
  function assertCategoriesAssignable(categoryIds: readonly string[], alreadyAssigned: readonly string[] = []) {
    if (!Array.isArray(categoryIds) || categoryIds.some((id) => typeof id !== "string")) {
      throw new CatalogueStoreError("VALIDATION_FAILED", "categoryIds must be an array of category ids");
    }
    if (new Set(categoryIds).size !== categoryIds.length) throw new CatalogueStoreError("VALIDATION_FAILED", "duplicate category id");
    for (const id of categoryIds) {
      const row = db.prepare("SELECT archived FROM categories WHERE id = ?").get(id) as { archived: number } | undefined;
      if (!row) throw new CatalogueStoreError("CATEGORY_NOT_FOUND", `category ${id} does not exist`);
      if (row.archived === 1 && !alreadyAssigned.includes(id)) throw new CatalogueStoreError("CATEGORY_ARCHIVED", `category ${id} is archived`);
    }
  }

  /** The recipe a command executes: required whenever the command names one. */
  function recipeFor(command: CommandRecord): Recipe | null {
    if (command.recipeId === null) return null;
    const recipe = currentRecipe(command.recipeId);
    if (!recipe) throw new CatalogueStoreError("RECIPE_NOT_FOUND", `recipe ${command.recipeId} does not exist`);
    return recipe;
  }

  // ---------- writes (inside a transaction) ----------

  function writeCommandColumns(command: CommandRecord) {
    return [
      command.lane,
      command.maturity,
      command.recipeId,
      command.display.en.name,
      command.display.en.description,
      command.display.de.name,
      command.display.de.description,
      command.job.en,
      command.job.de,
      canonicalJson(command),
    ] as const;
  }

  function insertCommand(command: CommandRecord, lifecycle: AuthoringLifecycle, origin: AuthoredCommand["origin"], at: string) {
    const sortKey = ((db.prepare("SELECT coalesce(max(sort_key), -1) + 1 AS next FROM commands").get() as { next: number }).next);
    try {
      db.prepare(
        `INSERT INTO commands (id, canonical_slash, lane, maturity, recipe_id, name_en, description_en, name_de, description_de, job_en, job_de, document,
           lifecycle, origin, sort_key, revision, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
      ).run(command.id, command.canonicalSlash, ...writeCommandColumns(command), lifecycle, origin, sortKey, at, at);
    } catch (error) {
      if (isConstraintError(error, /UNIQUE constraint failed: commands\.(id|canonical_slash)/)) {
        throw new CatalogueStoreError("COMMAND_ID_CONFLICT", `command ${command.id} already exists`);
      }
      throw error;
    }
    writeSlashes(command);
  }

  function writeSlashes(command: CommandRecord) {
    db.prepare("DELETE FROM command_slashes WHERE command_id = ? AND kind = 'alias'").run(command.id);
    const owner = db.prepare("SELECT command_id, kind FROM command_slashes WHERE slash = ?").get(command.canonicalSlash) as
      | { command_id: string; kind: string }
      | undefined;
    if (owner === undefined) {
      db.prepare("INSERT INTO command_slashes (slash, command_id, kind) VALUES (?, ?, 'canonical')").run(command.canonicalSlash, command.id);
    } else if (owner.command_id !== command.id || owner.kind !== "canonical") {
      throw new CatalogueStoreError("SLASH_CONFLICT", `${command.canonicalSlash} already belongs to command ${owner.command_id}`);
    }
    for (const alias of command.aliases) {
      try {
        db.prepare("INSERT INTO command_slashes (slash, command_id, kind) VALUES (?, ?, 'alias')").run(alias.slash, command.id);
      } catch (error) {
        if (isConstraintError(error, /UNIQUE constraint failed: command_slashes\.slash/)) {
          throw new CatalogueStoreError("SLASH_CONFLICT", `${alias.slash} is already taken`);
        }
        throw error;
      }
    }
  }

  function writeCategories(id: string, categoryIds: readonly string[]) {
    db.prepare("DELETE FROM command_categories WHERE command_id = ?").run(id);
    for (const categoryId of categoryIds) {
      db.prepare("INSERT INTO command_categories (command_id, category_id) VALUES (?, ?)").run(id, categoryId);
    }
  }

  function insertRecipeVersion(recipe: Recipe, origin: "vc01_import" | "authored", at: string) {
    db.prepare("INSERT INTO recipe_versions (recipe_id, version, truth_mode, document, origin, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      recipe.recipeId,
      recipe.version,
      recipe.truthMode,
      canonicalJson(recipe),
      origin,
      at,
    );
  }

  /** Moves a recipe's current version. Refused while an ACTIVE command executes it. */
  function moveCurrentVersion(recipe: Recipe, models: ModelRegistry, at: string) {
    const dependents = db
      .prepare("SELECT id, lifecycle, document FROM commands WHERE recipe_id = ? AND lifecycle <> 'ARCHIVED' ORDER BY sort_key")
      .all(recipe.recipeId) as { id: string; lifecycle: AuthoringLifecycle; document: string }[];
    const active = dependents.filter((row) => row.lifecycle === "ACTIVE").map((row) => row.id);
    if (active.length > 0) {
      throw new CatalogueStoreError(
        "RECIPE_IN_ACTIVE_USE",
        `${recipe.recipeId} is executed by ACTIVE command(s) ${active.join(", ")}; move them to TESTING first`,
      );
    }
    for (const row of dependents) validateCommand(parse<CommandRecord>(row.document), recipe, models);
    db.prepare("UPDATE recipes SET current_version = ?, updated_at = ? WHERE recipe_id = ?").run(recipe.version, at, recipe.recipeId);
    for (const row of dependents) {
      db.prepare("UPDATE commands SET revision = revision + 1, updated_at = ? WHERE id = ?").run(at, row.id);
      appendRevision(row.id, "recipe_version", at);
    }
  }

  /** Adds (or re-submits) a recipe version inside the caller's transaction. */
  function putRecipeVersion(recipe: Recipe, makeCurrent: boolean, models: ModelRegistry, at: string): RecipeVersionResult {
    const existing = recipeDocument(recipe.recipeId, recipe.version);
    const current = currentVersion(recipe.recipeId);
    if (existing !== null) {
      if (existing !== canonicalJson(recipe)) {
        throw new CatalogueStoreError("RECIPE_VERSION_CONFLICT", `${recipe.recipeId}@${recipe.version} exists with different content; versions are immutable`);
      }
      if (makeCurrent && current !== recipe.version) moveCurrentVersion(recipe, models, at);
      return { recipeId: recipe.recipeId, version: recipe.version, created: false, current: currentVersion(recipe.recipeId) === recipe.version };
    }
    const versions = (db.prepare("SELECT version FROM recipe_versions WHERE recipe_id = ?").all(recipe.recipeId) as { version: string }[]).map(
      (row) => row.version,
    );
    const newest = versions.sort(compareSemver).at(-1);
    if (newest !== undefined && compareSemver(recipe.version, newest) <= 0) {
      throw new CatalogueStoreError("RECIPE_VERSION_NOT_NEWER", `${recipe.recipeId}@${recipe.version} is not newer than ${newest}`);
    }
    insertRecipeVersion(recipe, "authored", at);
    if (current === null) {
      db.prepare("INSERT INTO recipes (recipe_id, current_version, updated_at) VALUES (?, ?, ?)").run(recipe.recipeId, recipe.version, at);
    } else if (makeCurrent) {
      moveCurrentVersion(recipe, models, at);
    }
    return { recipeId: recipe.recipeId, version: recipe.version, created: true, current: currentVersion(recipe.recipeId) === recipe.version };
  }

  function checkRecipeInput(recipe: Recipe, models: ModelRegistry) {
    assertNoForbiddenContent(recipe, "recipe");
    validateRecipe(recipe, models);
  }

  function checkCommandInput(command: CommandRecord) {
    assertNoForbiddenContent(command, "command");
  }

  function checkRevision(row: CommandRow, expectedRevision: number) {
    if (!Number.isInteger(expectedRevision) || row.revision !== expectedRevision) {
      throw new CatalogueStoreError("REVISION_CONFLICT", `command ${row.id} is at revision ${row.revision}, not ${expectedRevision}`);
    }
  }

  function requireCommand(id: string): CommandRow {
    const row = commandRow(id);
    if (!row) throw new CatalogueStoreError("COMMAND_NOT_FOUND", `command ${id} does not exist`);
    return row;
  }

  function validateCategoryInput(input: CategoryInput) {
    assertNoForbiddenContent(input, "category");
    const text = (value: unknown) => typeof value === "string" && value.trim().length > 0;
    const display = input?.display;
    const valid =
      typeof input?.id === "string" &&
      SLUG.test(input.id) &&
      typeof input.slug === "string" &&
      SLUG.test(input.slug) &&
      text(display?.en?.name) &&
      text(display?.en?.description) &&
      text(display?.de?.name) &&
      text(display?.de?.description);
    if (!valid) throw new CatalogueStoreError("VALIDATION_FAILED", "category needs a slug id and slug and non-empty DE/EN name and description");
  }

  // ---------- public read repositories (ACTIVE only) ----------

  const activeDocument = (sql: string, ...params: string[]) =>
    (db.prepare(sql).all(...params) as { document: string }[]).map((row) => parse<CommandRecord>(row.document));

  const commands: CommandRepository = {
    async listPublicCommands() {
      return activeDocument("SELECT document FROM commands WHERE lifecycle = 'ACTIVE' AND maturity <> 'deprecated' ORDER BY sort_key");
    },
    async getById(id) {
      return activeDocument("SELECT document FROM commands WHERE id = ? AND lifecycle = 'ACTIVE'", id)[0] ?? null;
    },
    async findBySlash(slash, resolveOptions) {
      const candidates = activeDocument(
        "SELECT c.document FROM command_slashes s JOIN commands c ON c.id = s.command_id WHERE s.slash = ? AND c.lifecycle = 'ACTIVE'",
        slash,
      );
      return matchCommandSlash(candidates, slash, resolveOptions) ?? null;
    },
  };

  const recipes: RecipeRepository = {
    async getById(recipeId) {
      return currentRecipe(recipeId);
    },
  };

  const categories: CategoryRepository = {
    async listActive() {
      return (db.prepare("SELECT * FROM categories WHERE archived = 0 ORDER BY slug").all() as unknown as CategoryRow[]).map(toCategory);
    },
  };

  // ---------- authoring repository (operator boundary) ----------

  const authoring: AuthoringRepository = {
    async createCategory(input) {
      validateCategoryInput(input);
      const at = now();
      try {
        db.prepare(
          "INSERT INTO categories (id, slug, name_en, description_en, name_de, description_de, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)",
        ).run(input.id, input.slug, input.display.en.name, input.display.en.description, input.display.de.name, input.display.de.description, at, at);
      } catch (error) {
        if (isConstraintError(error, /UNIQUE constraint failed: categories\./)) {
          throw new CatalogueStoreError("CATEGORY_CONFLICT", `category ${input.id} / ${input.slug} already exists`);
        }
        throw error;
      }
      return toCategory(db.prepare("SELECT * FROM categories WHERE id = ?").get(input.id) as unknown as CategoryRow);
    },

    async archiveCategory(id) {
      requireText(id);
      const result = db.prepare("UPDATE categories SET archived = 1, updated_at = ? WHERE id = ?").run(now(), id);
      if (result.changes === 0) throw new CatalogueStoreError("CATEGORY_NOT_FOUND", `category ${id} does not exist`);
      return toCategory(db.prepare("SELECT * FROM categories WHERE id = ?").get(id) as unknown as CategoryRow);
    },

    async listCategories(listOptions = {}) {
      const sql = listOptions.includeArchived ? "SELECT * FROM categories ORDER BY slug" : "SELECT * FROM categories WHERE archived = 0 ORDER BY slug";
      return (db.prepare(sql).all() as unknown as CategoryRow[]).map(toCategory);
    },

    async addRecipeVersion(recipe, addOptions = {}) {
      const models = await registry();
      checkRecipeInput(recipe, models);
      return inTransaction(db, () => putRecipeVersion(recipe, addOptions.makeCurrent === true, models, now()));
    },

    async setCurrentRecipeVersion(recipeId, version) {
      requireText(recipeId, version);
      const models = await registry();
      return inTransaction(db, () => {
        const document = recipeDocument(recipeId, version);
        if (document === null) throw new CatalogueStoreError("RECIPE_NOT_FOUND", `${recipeId}@${version} does not exist`);
        const recipe = parse<Recipe>(document);
        validateRecipe(recipe, models);
        if (currentVersion(recipeId) !== version) moveCurrentVersion(recipe, models, now());
        return { recipeId, version, created: false, current: true };
      });
    },

    async getRecipeVersion(recipeId, version) {
      requireText(recipeId, version);
      const document = recipeDocument(recipeId, version);
      return document === null ? null : parse<Recipe>(document);
    },

    async listRecipeVersions(recipeId) {
      requireText(recipeId);
      return (db.prepare("SELECT version FROM recipe_versions WHERE recipe_id = ?").all(recipeId) as { version: string }[])
        .map((row) => row.version)
        .sort(compareSemver);
    },

    async createDraftCommand(input) {
      const models = await registry();
      const { command, recipe } = input;
      const categoryIds = input.categoryIds ?? [];
      checkCommandInput(command);
      if (recipe !== undefined) {
        checkRecipeInput(recipe, models);
        if (recipe.recipeId !== command.recipeId) {
          throw new CatalogueStoreError("VALIDATION_FAILED", `recipe ${recipe.recipeId} is not the command's recipe ${String(command.recipeId)}`);
        }
      }
      return inTransaction(db, () => {
        const at = now();
        if (recipe !== undefined) {
          // A new recipe id starts at this version. For an existing recipe the given version must be the
          // current one: creating a command never moves what other commands execute (addRecipeVersion /
          // setCurrentRecipeVersion do that, explicitly).
          const current = currentVersion(recipe.recipeId);
          if (current === null) {
            putRecipeVersion(recipe, false, models, at);
          } else {
            const existing = recipeDocument(recipe.recipeId, recipe.version);
            if (existing !== null && existing !== canonicalJson(recipe)) {
              throw new CatalogueStoreError("RECIPE_VERSION_CONFLICT", `${recipe.recipeId}@${recipe.version} exists with different content; versions are immutable`);
            }
            if (current !== recipe.version) {
              throw new CatalogueStoreError(
                "RECIPE_VERSION_NOT_CURRENT",
                `${recipe.recipeId} executes ${current}, not ${recipe.version}; add or select versions with addRecipeVersion/setCurrentRecipeVersion`,
              );
            }
          }
        }
        validateCommand(command, recipeFor(command), models);
        // canonicalSlash is "/" + id (contract rule), so an existing id is a taken canonical slash
        if (commandRow(command.id)) {
          throw new CatalogueStoreError("SLASH_CONFLICT", `${command.canonicalSlash} already belongs to command ${command.id}`);
        }
        assertSlashesFree(command);
        assertCategoriesAssignable(categoryIds);
        insertCommand(command, "DRAFT", "authored", at);
        writeCategories(command.id, categoryIds);
        appendRevision(command.id, "create", at);
        return toAuthored(commandRow(command.id)!);
      });
    },

    async updateCommand(id, input) {
      requireText(id);
      const models = await registry();
      const { command, categoryIds, expectedRevision } = input;
      checkCommandInput(command);
      return inTransaction(db, () => {
        const row = requireCommand(id);
        checkRevision(row, expectedRevision);
        if (row.lifecycle !== "DRAFT" && row.lifecycle !== "TESTING") {
          throw new CatalogueStoreError("NOT_EDITABLE", `command ${id} is ${row.lifecycle}; only DRAFT and TESTING are edited`);
        }
        if (command?.id !== id) throw new CatalogueStoreError("VALIDATION_FAILED", "a command's id (and canonical slash) never changes");
        validateCommand(command, recipeFor(command), models);
        assertSlashesFree(command);
        assertCategoriesAssignable(categoryIds, categoryIdsOf(id));
        const at = now();
        db.prepare(
          `UPDATE commands SET lane = ?, maturity = ?, recipe_id = ?, name_en = ?, description_en = ?, name_de = ?, description_de = ?, job_en = ?, job_de = ?,
             document = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
        ).run(...writeCommandColumns(command), at, id);
        writeSlashes(command);
        writeCategories(id, categoryIds);
        appendRevision(id, "update", at);
        return toAuthored(commandRow(id)!);
      });
    },

    async transitionCommand(id, to, transitionOptions) {
      requireText(id);
      if (!AUTHORING_LIFECYCLES.includes(to)) throw new CatalogueStoreError("LIFECYCLE_INVALID", `unknown lifecycle ${String(to)}`);
      const models = await registry();
      return inTransaction(db, () => {
        const row = requireCommand(id);
        checkRevision(row, transitionOptions?.expectedRevision);
        if (!LIFECYCLE_TRANSITIONS.has(`${row.lifecycle}>${to}`)) {
          throw new CatalogueStoreError("LIFECYCLE_TRANSITION_FORBIDDEN", `${row.lifecycle} -> ${to} is not an authoring transition`);
        }
        if (to === "ACTIVE" || row.lifecycle === "ARCHIVED") {
          // Promotion, and restoring an archived record, re-validate it with the recipe it would now
          // execute and the live registry (the recipe may have moved on while it was archived).
          const command = parse<CommandRecord>(row.document);
          validateCommand(command, recipeFor(command), models);
        }
        const at = now();
        db.prepare("UPDATE commands SET lifecycle = ?, archived_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?").run(
          to,
          to === "ARCHIVED" ? at : null,
          at,
          id,
        );
        appendRevision(id, "transition", at);
        return toAuthored(commandRow(id)!);
      });
    },

    async archiveCommand(id, archiveOptions) {
      return authoring.transitionCommand(id, "ARCHIVED", archiveOptions);
    },

    async getCommand(id) {
      requireText(id);
      return readConsistent(() => {
        const row = commandRow(id);
        return row ? toAuthored(row) : null;
      });
    },

    async listCommands(query: CommandQuery = {}) {
      const lifecycles = query.lifecycles ?? AUTHORING_LIFECYCLES.filter((lifecycle) => lifecycle !== "ARCHIVED");
      if (lifecycles.length === 0 || lifecycles.some((lifecycle) => !AUTHORING_LIFECYCLES.includes(lifecycle))) {
        throw new CatalogueStoreError("LIFECYCLE_INVALID", `invalid lifecycle filter ${JSON.stringify(lifecycles)}`);
      }
      const where = [`c.lifecycle IN (${lifecycles.map(() => "?").join(", ")})`];
      const params: string[] = [...lifecycles];
      if (query.lane !== undefined) {
        where.push("c.lane = ?");
        params.push(query.lane);
      }
      if (query.categoryId !== undefined) {
        where.push("EXISTS (SELECT 1 FROM command_categories cc WHERE cc.command_id = c.id AND cc.category_id = ?)");
        params.push(query.categoryId);
      }
      return readConsistent(() => {
      const rows = db
        .prepare(
          `SELECT c.id, c.lifecycle, c.document, c.recipe_id, c.origin, c.revision, c.created_at, c.updated_at, c.archived_at
           FROM commands c WHERE ${where.join(" AND ")} ORDER BY c.sort_key`,
        )
        .all(...params) as unknown as CommandRow[];
      return rows.map(toAuthored);
      });
    },

    async getCommandHistory(id) {
      requireText(id);
      const rows = db
        .prepare("SELECT revision, lifecycle, document, category_ids, recipe_version, reason, recorded_at FROM command_revisions WHERE command_id = ? ORDER BY revision")
        .all(id) as {
        revision: number;
        lifecycle: AuthoringLifecycle;
        document: string;
        category_ids: string;
        recipe_version: string | null;
        reason: CommandRevision["reason"];
        recorded_at: string;
      }[];
      return rows.map((row) => ({
        revision: row.revision,
        lifecycle: row.lifecycle,
        command: parse<CommandRecord>(row.document),
        categoryIds: parse<string[]>(row.category_ids),
        recipeVersion: row.recipe_version,
        reason: row.reason,
        recordedAt: row.recorded_at,
      }));
    },
  };

  // ---------- seed import ----------

  async function importSeed(bundle: SeedBundle, importOptions: { source?: string } = {}): Promise<SeedImportReport> {
    const models = await registry();
    // the same per-document rules and caps as authored writes (a malformed bundle is reported below)
    const seedList = (document: unknown, key: string) => {
      const list = (document as Record<string, unknown> | null)?.[key];
      return Array.isArray(list) ? list : [];
    };
    for (const command of seedList(bundle.catalogue, "commands")) assertNoForbiddenContent(command, "command");
    for (const recipe of seedList(bundle.recipes, "recipes")) assertNoForbiddenContent(recipe, "recipe");
    const issues = validateContract({ catalogue: bundle.catalogue, recipes: bundle.recipes, models });
    if (issues.length > 0) throw new CatalogueStoreError("IMPORT_SOURCE_INVALID", issuesText(issues), { issues });
    const seedCommands = (bundle.catalogue as { commands: CommandRecord[] }).commands;
    const seedRecipes = (bundle.recipes as { recipes: Recipe[] }).recipes;
    const sourceDigest = createHash("sha256").update(canonicalJson({ catalogue: bundle.catalogue, recipes: bundle.recipes })).digest("hex");

    return inTransaction(db, () => {
      const at = now();
      const conflicts: string[] = [];
      const report = { commandsInserted: 0, commandsUnchanged: 0, recipesInserted: 0, recipesUnchanged: 0, sourceDigest };
      // The first successful import bootstraps the catalogue from the seed (next to any authored content
      // that does not collide with it). Afterwards the database is the source of truth and the JSON is
      // history: a re-run only confirms that the seed still equals what was imported, and anything new
      // or different in it is refused, so the JSON never becomes a second way to publish.
      const bootstrapped = (db.prepare("SELECT count(*) AS n FROM import_runs").get() as { n: number }).n > 0;
      const after = "the catalogue was bootstrapped from the seed; author new content through the repository";

      for (const recipe of seedRecipes) {
        // Every seed recipe id is owned by the seed: only versions the seed itself imported count as
        // equal. An authored version, even with identical content, is a conflict, so a seed command is
        // never bound to a recipe history it was not validated with.
        const existing = db.prepare("SELECT document, origin FROM recipe_versions WHERE recipe_id = ? AND version = ?").get(recipe.recipeId, recipe.version) as
          | { document: string; origin: string }
          | undefined;
        const authoredVersions = (
          db.prepare("SELECT version FROM recipe_versions WHERE recipe_id = ? AND origin = 'authored' ORDER BY version").all(recipe.recipeId) as { version: string }[]
        ).map((row) => row.version);
        if (existing && existing.origin !== "vc01_import") {
          conflicts.push(`recipe ${recipe.recipeId}@${recipe.version}: persisted as an authored version, not imported from the seed`);
        } else if (existing && existing.document !== canonicalJson(recipe)) {
          conflicts.push(`recipe ${recipe.recipeId}@${recipe.version}: persisted content differs from the seed`);
        } else if (existing) {
          report.recipesUnchanged += 1;
        } else if (bootstrapped) {
          conflicts.push(`recipe ${recipe.recipeId}@${recipe.version}: not part of the imported seed; ${after}`);
        } else if (authoredVersions.length > 0) {
          conflicts.push(`recipe ${recipe.recipeId}: already authored (${authoredVersions.join(", ")}) before the seed import`);
        } else {
          insertRecipeVersion(recipe, "vc01_import", at);
          db.prepare("INSERT INTO recipes (recipe_id, current_version, updated_at) VALUES (?, ?, ?)").run(recipe.recipeId, recipe.version, at);
          report.recipesInserted += 1;
        }
      }

      for (const command of seedCommands) {
        if (commandRow(command.id)) {
          // Compared with what this seed imported (revision \"import\"), not with today's record: the
          // operator may have evolved an imported command since, which is not a seed conflict.
          const imported = (
            db.prepare("SELECT document FROM command_revisions WHERE command_id = ? AND reason = 'import' ORDER BY revision LIMIT 1").get(command.id) as
              | { document: string }
              | undefined
          )?.document;
          if (imported === canonicalJson(command)) report.commandsUnchanged += 1;
          else if (imported === undefined) conflicts.push(`command ${command.id}: an authored command already uses this id`);
          else conflicts.push(`command ${command.id}: persisted record differs from the seed`);
          continue;
        }
        if (bootstrapped) {
          conflicts.push(`command ${command.id}: not part of the imported seed; ${after}`);
          continue;
        }
        const taken = [command.canonicalSlash, ...command.aliases.map((alias) => alias.slash)]
          .map((slash) => ({ slash, owner: (db.prepare("SELECT command_id FROM command_slashes WHERE slash = ?").get(slash) as { command_id: string } | undefined)?.command_id }))
          .filter((entry) => entry.owner !== undefined);
        if (taken.length > 0) {
          conflicts.push(...taken.map((entry) => `command ${command.id}: ${entry.slash} already belongs to ${entry.owner}`));
          continue;
        }
        if (conflicts.length > 0) continue; // rolled back below; keep collecting conflicts only
        // VC-01 commands are the published catalogue: they enter ACTIVE, exactly as served before.
        insertCommand(command, "ACTIVE", "vc01_import", at);
        writeCategories(command.id, []);
        appendRevision(command.id, "import", at);
        report.commandsInserted += 1;
      }

      if (conflicts.length > 0) {
        throw new CatalogueStoreError("IMPORT_CONFLICT", `${conflicts.length} conflict(s); nothing was imported`, { conflicts });
      }
      db.prepare(
        "INSERT INTO import_runs (source, source_digest, commands_inserted, commands_unchanged, recipes_inserted, recipes_unchanged, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(importOptions.source ?? "seed", sourceDigest, report.commandsInserted, report.commandsUnchanged, report.recipesInserted, report.recipesUnchanged, at);
      return report;
    });
  }

  let open = true;
  const close = () => {
    if (open) db.close();
    open = false;
  };
  return {
    commands: guarded(commands),
    recipes: guarded(recipes),
    categories: guarded(categories),
    authoring: guarded(authoring),
    importSeed: guarded({ importSeed }).importSeed,
    close,
  };
}
