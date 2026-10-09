import type { CommandRecord, Lane, Recipe } from "../../domain/contract/types.ts";
import type { CategoryRecord } from "../catalogue/port.ts";

/**
 * VC-02 authoring lifecycle (DYAI-38). Deliberately separate from the contract's `maturity` and
 * `evidence` (DYAI-31): lifecycle says where a command is in the operator's authoring loop, maturity
 * and evidence say how proven its recipe is. Only ACTIVE commands reach the public repositories.
 */
export type AuthoringLifecycle = "DRAFT" | "TESTING" | "ACTIVE" | "ARCHIVED";
export const AUTHORING_LIFECYCLES: readonly AuthoringLifecycle[] = ["DRAFT", "TESTING", "ACTIVE", "ARCHIVED"];

export interface AuthoredCommand {
  /** The contract record exactly as persisted (what the public repositories serve once ACTIVE). */
  command: CommandRecord;
  lifecycle: AuthoringLifecycle;
  categoryIds: string[];
  /** Current version of the command's recipe, or null for a command without recipe. */
  recipeVersion: string | null;
  origin: "vc01_import" | "authored";
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface CommandRevision {
  revision: number;
  lifecycle: AuthoringLifecycle;
  command: CommandRecord;
  categoryIds: string[];
  recipeVersion: string | null;
  reason: "import" | "create" | "update" | "transition" | "recipe_version";
  recordedAt: string;
}

export interface CategoryInput {
  id: string;
  slug: string;
  display: CategoryRecord["display"];
}

export interface CommandQuery {
  lane?: Lane;
  categoryId?: string;
  /** Default: every lifecycle except ARCHIVED. */
  lifecycles?: AuthoringLifecycle[];
}

export interface RecipeVersionResult {
  recipeId: string;
  version: string;
  /** False when the identical version already existed (idempotent re-submission). */
  created: boolean;
  current: boolean;
}

/**
 * Operator-only authoring boundary over durable persistence. Server code only: no client component may
 * reach it (tests/ui-boundary.test.mjs). Every write is validated against the DYAI-31 contract with
 * the separate Model Capability registry and fails closed with a CatalogueStoreError.
 */
export interface AuthoringRepository {
  createCategory(input: CategoryInput): Promise<CategoryRecord>;
  archiveCategory(id: string): Promise<CategoryRecord>;
  listCategories(options?: { includeArchived?: boolean }): Promise<CategoryRecord[]>;

  /** Adds an immutable recipe version. A new recipe id starts at it; an existing one moves only with makeCurrent. */
  addRecipeVersion(recipe: Recipe, options?: { makeCurrent?: boolean }): Promise<RecipeVersionResult>;
  setCurrentRecipeVersion(recipeId: string, version: string): Promise<RecipeVersionResult>;
  getRecipeVersion(recipeId: string, version: string): Promise<Recipe | null>;
  listRecipeVersions(recipeId: string): Promise<string[]>;

  /**
   * Creates a DRAFT command. `recipe`, when given, must carry the command's recipeId: a new recipe id is
   * added in the same transaction; for an existing recipe id it must be the current version
   * (RECIPE_VERSION_NOT_CURRENT otherwise; creating a command never moves what other commands execute).
   * Without `recipe`, the command's recipeId must already exist.
   */
  createDraftCommand(input: { command: CommandRecord; categoryIds?: string[]; recipe?: Recipe }): Promise<AuthoredCommand>;
  /** Replaces a DRAFT or TESTING command's record and categories (optimistic: expectedRevision). */
  updateCommand(id: string, input: { command: CommandRecord; categoryIds: string[]; expectedRevision: number }): Promise<AuthoredCommand>;
  transitionCommand(id: string, to: AuthoringLifecycle, options: { expectedRevision: number }): Promise<AuthoredCommand>;
  /** Soft removal: lifecycle ARCHIVED, record and history kept. */
  archiveCommand(id: string, options: { expectedRevision: number }): Promise<AuthoredCommand>;

  getCommand(id: string): Promise<AuthoredCommand | null>;
  listCommands(query?: CommandQuery): Promise<AuthoredCommand[]>;
  getCommandHistory(id: string): Promise<CommandRevision[]>;
}
