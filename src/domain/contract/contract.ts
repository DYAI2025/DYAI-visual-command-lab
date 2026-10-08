import { validateContract } from "./validate-contract.ts";
import type {
  CommandCatalogue,
  CommandRecord,
  ContractBundle,
  ContractIssue,
  ModelCapability,
  ModelRegistry,
  Recipe,
  RecipeBook,
  TruthMode,
} from "./types.ts";

export class ContractInvalidError extends Error {
  readonly issues: ContractIssue[];

  constructor(issues: ContractIssue[]) {
    super(`Visual Command contract is invalid:\n${issues.map((i) => `${i.code} ${i.path}: ${i.message}`).join("\n")}`);
    this.name = "ContractInvalidError";
    this.issues = issues;
  }
}

export type ResolutionErrorCode =
  | "COMMAND_NOT_FOUND"
  | "COMMAND_NOT_EXECUTABLE"
  | "RECIPE_NOT_ASSIGNED"
  | "NO_COMPATIBLE_MODEL"
  | "NO_APPROVED_MODEL";

export class ContractResolutionError extends Error {
  readonly code: ResolutionErrorCode;

  constructor(code: ResolutionErrorCode, message: string) {
    super(message);
    this.name = "ContractResolutionError";
    this.code = code;
  }
}

export interface ExecutionPlan {
  commandId: string;
  canonicalSlash: string;
  recipeId: string;
  recipeVersion: string;
  truthMode: TruthMode;
  modelId: string;
}

export interface ResolveCommandOptions {
  /** Brand aliases resolve only after an explicit decision to accept their review state. */
  allowReviewRequiredAliases?: boolean;
}

export function createContract(bundle: ContractBundle) {
  const issues = validateContract(bundle);
  if (issues.length > 0) throw new ContractInvalidError(issues);

  const commands: readonly CommandRecord[] = (bundle.catalogue as CommandCatalogue).commands;
  const recipes = new Map((bundle.recipes as RecipeBook).recipes.map((recipe) => [recipe.recipeId, recipe]));
  const models: readonly ModelCapability[] = (bundle.models as ModelRegistry).models;

  /** "/slash" resolves the canonical slash or an alias; anything else is looked up as a command id. */
  function resolveCommand(slashOrId: string, options: ResolveCommandOptions = {}): CommandRecord {
    if (!slashOrId.startsWith("/")) {
      const byId = commands.find((item) => item.id === slashOrId);
      if (!byId) throw new ContractResolutionError("COMMAND_NOT_FOUND", `No command has id ${slashOrId}`);
      return byId;
    }
    const slash = slashOrId;
    const command =
      commands.find((item) => item.canonicalSlash === slash) ??
      commands.find((item) =>
        item.aliases.some(
          (alias) =>
            alias.slash === slash &&
            (alias.publicUse === "allowed" ||
              (alias.publicUse === "review_required" && options.allowReviewRequiredAliases === true)),
        ),
      );
    if (!command) throw new ContractResolutionError("COMMAND_NOT_FOUND", `No command resolves ${slash}`);
    return command;
  }

  /** The command's recipe. Candidates have none; deprecated commands are not executable. */
  function resolveRecipe(command: CommandRecord): Recipe {
    if (command.maturity === "deprecated") {
      throw new ContractResolutionError("COMMAND_NOT_EXECUTABLE", `${command.canonicalSlash} is deprecated`);
    }
    const recipe = command.recipeId === null ? undefined : recipes.get(command.recipeId);
    if (!recipe) {
      throw new ContractResolutionError(
        "RECIPE_NOT_ASSIGNED",
        `${command.canonicalSlash} (maturity ${command.maturity}) has no executable recipe`,
      );
    }
    return recipe;
  }

  /**
   * Active models that can take what the command accepts and the recipe needs: reference images, and
   * at least as many as the command accepts. Image output and text input hold for every registry
   * model (validator invariants). Allowlist state is returned, not filtered; resolveExecutionPlan
   * applies it.
   */
  function findCompatibleModels(command: CommandRecord, recipe: Recipe): ModelCapability[] {
    const { sourceImage, maxSourceImages } = command.inputRequirements;
    const needsImages = recipe.inputs.referenceImage !== "none" || sourceImage !== "none";
    return models.filter(
      (model) =>
        model.lifecycle === "active" &&
        (!needsImages ||
          (model.capabilities.referenceImage && model.capabilities.maxReferenceImages >= maxSourceImages)),
    );
  }

  /**
   * Resolves the model a generation would run on. It needs an allowlisted, compatible model whose
   * adapter is approved on this recipe; anything less fails closed.
   */
  function resolveExecutionPlan(slashOrId: string, options: ResolveCommandOptions = {}): ExecutionPlan {
    const command = resolveCommand(slashOrId, options);
    const recipe = resolveRecipe(command);
    const compatible = findCompatibleModels(command, recipe);
    if (compatible.length === 0) {
      throw new ContractResolutionError("NO_COMPATIBLE_MODEL", `No active model can run ${recipe.recipeId}`);
    }
    const approved = recipe.modelAdapters
      .filter((adapter) => adapter.status === "approved")
      .map((adapter) => compatible.find((model) => model.id === adapter.modelRef && model.allowlist === "allowed"))
      .find((model) => model !== undefined);
    if (!approved) {
      throw new ContractResolutionError(
        "NO_APPROVED_MODEL",
        `${recipe.recipeId}@${recipe.version} has no approved adapter on an allowlisted model`,
      );
    }
    return {
      commandId: command.id,
      canonicalSlash: command.canonicalSlash,
      recipeId: recipe.recipeId,
      recipeVersion: recipe.version,
      truthMode: recipe.truthMode,
      modelId: approved.id,
    };
  }

  return { commands, resolveCommand, resolveRecipe, findCompatibleModels, resolveExecutionPlan };
}

export type ExecutionContract = ReturnType<typeof createContract>;
