import { staticCategoryRepository, staticCommandRepository, staticRecipeRepository } from "./static-adapter.ts";
import { readCatalogueStoreConfig } from "./config.ts";
import { modelRegistry } from "../models/index.ts";
import type { CategoryRepository, CommandRepository, RecipeRepository } from "./port.ts";
import type { SqliteCatalogueStore } from "../persistence/sqlite-store.ts";

// Runtime binding of the catalogue ports (DYAI-39). The adapter is chosen from the environment on
// first use and kept for the process. `static` (default) serves the validated bootstrap data;
// `sqlite` serves the durable store and fails closed (CatalogueStoreError) when it is missing,
// unmigrated or unreadable. A failed open is not cached, so every request reports it until the
// store is fixed; there is no fallback to the static data.

export interface CatalogueBinding {
  adapter: "static" | "sqlite";
  commands: CommandRepository;
  recipes: RecipeRepository;
  categories: CategoryRepository;
  /** The durable store when adapter is sqlite (authoring boundary), else null. */
  store: SqliteCatalogueStore | null;
}

const STATIC_BINDING: CatalogueBinding = {
  adapter: "static",
  commands: staticCommandRepository,
  recipes: staticRecipeRepository,
  categories: staticCategoryRepository,
  store: null,
};

let binding: Promise<CatalogueBinding> | null = null;

async function bind(): Promise<CatalogueBinding> {
  const config = readCatalogueStoreConfig(process.env);
  if (config.adapter === "static") return STATIC_BINDING;
  // Loaded only when configured: the default runtime never touches node:sqlite.
  const { openSqliteCatalogueStore } = await import("../persistence/sqlite-store.ts");
  const store = openSqliteCatalogueStore({ file: config.file, models: modelRegistry });
  return { adapter: "sqlite", commands: store.commands, recipes: store.recipes, categories: store.categories, store };
}

export function catalogueBinding(): Promise<CatalogueBinding> {
  binding ??= bind().catch((error: unknown) => {
    binding = null;
    throw error;
  });
  return binding;
}

/** Test seam: closes and forgets the bound adapter so the next call re-reads the environment. */
export async function resetCatalogueBinding(): Promise<void> {
  const current = binding;
  binding = null;
  const bound = await current?.catch(() => null);
  bound?.store?.close();
}

export const commandRepository: CommandRepository = {
  async listPublicCommands() {
    return (await catalogueBinding()).commands.listPublicCommands();
  },
  async getById(id) {
    return (await catalogueBinding()).commands.getById(id);
  },
  async findBySlash(slash, options) {
    return (await catalogueBinding()).commands.findBySlash(slash, options);
  },
};
export const recipeRepository: RecipeRepository = {
  async getById(recipeId) {
    return (await catalogueBinding()).recipes.getById(recipeId);
  },
};
export const categoryRepository: CategoryRepository = {
  async listActive() {
    return (await catalogueBinding()).categories.listActive();
  },
};
export type { CommandRepository, RecipeRepository, CategoryRepository, CategoryRecord } from "./port.ts";
