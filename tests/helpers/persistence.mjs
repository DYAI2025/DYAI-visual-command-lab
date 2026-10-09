// Real-file SQLite fixtures for the DYAI-39 persistence tests. Every database lives in its own temp
// directory and is opened through the same code the runtime uses; nothing here is an in-memory fake.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { migrate, openDatabase } from "../../src/server/persistence/database.ts";
import { openSqliteCatalogueStore } from "../../src/server/persistence/sqlite-store.ts";
import { modelRegistry } from "../../src/server/models/index.ts";

/** The committed VC-01 seed, read as the import CLI reads it (fresh copies every call). */
export const seedBundle = () => ({
  catalogue: JSON.parse(fs.readFileSync("src/domain/commands/catalogue.json", "utf8")),
  recipes: JSON.parse(fs.readFileSync("src/server/recipes/recipes.json", "utf8")),
});

export const committedRegistry = await modelRegistry.load();
export const registryPort = (registry = committedRegistry) => ({ async load() { return structuredClone(registry); } });

/** A fresh temp directory and the path of a migrated, empty database file in it. */
export function migratedDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dyai39-"));
  const file = path.join(dir, "catalogue.db");
  const db = openDatabase(file, { create: true });
  migrate(db);
  db.close();
  return { dir, file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

let tick = 0;
/** Monotonic, deterministic timestamps. */
export const clock = () => new Date(Date.UTC(2026, 9, 9, 12, 0, tick++)).toISOString();

export function openStore(file, { models = registryPort(), now = clock } = {}) {
  return openSqliteCatalogueStore({ file, models, now });
}

/** Migrated database with the VC-01 seed imported; returns an open store. */
export async function seededStore(options = {}) {
  const fixture = migratedDatabase();
  const store = openStore(fixture.file, options);
  await store.importSeed(seedBundle());
  return { ...fixture, store };
}

/** Raw read-only look at a database file (for asserting what is physically stored). */
export function rawQuery(file, sql, ...params) {
  const db = openDatabase(file, { create: false });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

export const category = (id, overrides = {}) => ({
  id,
  slug: id,
  display: {
    en: { name: `Category ${id}`, description: `Commands about ${id}.` },
    de: { name: `Kategorie ${id}`, description: `Befehle zu ${id}.` },
  },
  ...overrides,
});

/** A new, contract-valid PLAY recipe (truth mode creative, reference image required). */
export const newRecipe = (recipeId = "sticker-v1", version = "0.1.0", overrides = {}) => ({
  recipeId,
  version,
  baseIntent: "Turn the subject of the reference image into a glossy die-cut sticker with a white border.",
  truthMode: "creative_entertainment",
  inputs: { referenceImage: "required" },
  preserve: ["subject_identity", "pose"],
  mayChange: ["rendering_style", "background"],
  mutableRegions: ["background"],
  immutableFeatures: ["subject silhouette"],
  constraints: ["Keep a single white contour border."],
  negativeConstraints: ["No text added."],
  parameters: [{ name: "finish", type: "enum", required: false, options: ["glossy", "matte"], default: "glossy", description: "Surface finish." }],
  modelAdapters: [],
  expectedFailureModes: [{ id: "border-cut", description: "Border clips the subject." }],
  confirmationGates: [],
  testedModels: [],
  lastTestedAt: null,
  fixtureRefs: [],
  evaluationStatus: "untested",
  ...overrides,
});

/** A new DRAFT-able PLAY command that uses `recipeId` (maturity seed: it has a recipe). */
export const newCommand = (id = "sticker", recipeId = "sticker-v1", overrides = {}) => ({
  id,
  canonicalSlash: `/${id}`,
  aliases: [],
  lane: "play",
  display: {
    en: { name: "Sticker", description: "Turns your photo into a die-cut sticker." },
    de: { name: "Sticker", description: "Macht aus deinem Foto einen gestanzten Aufkleber." },
  },
  semanticClass: "visual_transform",
  tags: ["play", "sticker"],
  job: { en: "Make a shareable sticker of me.", de: "Mach einen teilbaren Sticker von mir." },
  recipeId,
  inputRequirements: { sourceImage: "required", maxSourceImages: 1, acceptedMimeTypes: ["image/jpeg", "image/png", "image/webp"], textInstruction: "optional" },
  thumbnails: [],
  riskFlags: ["synthetic_visualisation", "person_likeness"],
  maturity: recipeId === null ? "candidate" : "seed",
  evidence: { observation: "proposed", status: "unverified", refs: [] },
  provenance: "custom",
  ...overrides,
});

/** Row counts of every authoring table: proves a rejected write left nothing behind. */
export function tableCounts(file) {
  const tables = ["categories", "recipe_versions", "recipes", "commands", "command_slashes", "command_categories", "command_revisions", "import_runs"];
  return Object.fromEntries(tables.map((table) => [table, rawQuery(file, `SELECT count(*) AS n FROM ${table}`)[0].n]));
}

export async function rejects(promise, code) {
  let error;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  if (!error) throw new Error(`expected CatalogueStoreError ${code}, but the call succeeded`);
  if (error.name !== "CatalogueStoreError" || error.code !== code) {
    throw new Error(`expected CatalogueStoreError ${code}, got ${error.name} ${error.code ?? ""}: ${error.message}`);
  }
  return error;
}
