import {
  ContractInvalidError,
  ContractResolutionError,
  createContract,
  type ExecutionContract,
  type ExecutionPlan,
} from "../../domain/contract/contract.ts";
import { validateCatalogue } from "../../domain/contract/validate-catalogue.ts";
import type { CommandRecord, ModelCapability, Recipe } from "../../domain/contract/types.ts";
import type { CommandRepository, RecipeRepository } from "../catalogue/port.ts";
import type { ModelRegistryPort } from "../models/port.ts";

// Command -> Recipe -> Model resolution for one generation, through the application boundary:
// Commands and Recipes from the catalogue repositories (static bootstrap adapter today, DYAI-39
// persistence later), models from the separate Model Capability registry. Nothing here reads the
// catalogue or recipe JSON; whatever the repositories return is the runtime truth.
//
// Each resolution reads one command, its one recipe and the registry once, then validates exactly
// that snapshot with the domain contract validator (cross-document invariants: allowlist needs an
// approved privacy review and a passing benchmark, an approved adapter needs a passing test, ...).
// A snapshot that fails validation is not executed (ContractInvalidError propagates): broken
// repository data is a configuration failure (503), never a client-side 422.

export interface ExecutionSources {
  commands: CommandRepository;
  recipes: RecipeRepository;
  models: ModelRegistryPort;
}

export interface ResolvedExecution {
  command: CommandRecord;
  recipe: Recipe;
  model: ModelCapability;
  adapter: Recipe["modelAdapters"][number];
  plan: ExecutionPlan;
}

/** "/slash" resolves the canonical slash or a public alias; anything else is a command id. */
export async function resolveCommandRef(ref: string, commands: CommandRepository): Promise<CommandRecord> {
  const command = ref.startsWith("/") ? await commands.findBySlash(ref) : await commands.getById(ref);
  if (!command) throw new ContractResolutionError("COMMAND_NOT_FOUND", `No command resolves ${ref}`);
  return command;
}

export interface ExecutionSnapshot {
  command: CommandRecord;
  recipe: Recipe;
  /** The validated one-command contract built from exactly what the sources returned. */
  contract: ExecutionContract;
}

/**
 * Reads the command's recipe and the registry once and validates that snapshot. Data errors (an
 * invalid command record, a recipe id that resolves to nothing, cross-document violations) throw
 * ContractInvalidError; legitimate non-executable states keep their ContractResolutionError codes.
 */
export async function loadExecutionSnapshot(command: CommandRecord, sources: ExecutionSources): Promise<ExecutionSnapshot> {
  const commandIssues = validateCatalogue({ schemaVersion: "1.0.0", commands: [command] });
  if (commandIssues.length > 0) throw new ContractInvalidError(commandIssues);
  if (command.maturity === "deprecated") {
    throw new ContractResolutionError("COMMAND_NOT_EXECUTABLE", `${command.canonicalSlash} is deprecated`);
  }
  // A valid record without a recipe id is a candidate: not executable yet.
  if (command.recipeId === null) {
    throw new ContractResolutionError(
      "RECIPE_NOT_ASSIGNED",
      `${command.canonicalSlash} (maturity ${command.maturity}) has no executable recipe`,
    );
  }
  const recipe = await sources.recipes.getById(command.recipeId);
  if (!recipe) {
    throw new ContractInvalidError([
      { code: "COMMAND_RECIPE_UNRESOLVED", path: "/commands/0/recipeId", message: `recipe ${command.recipeId} does not exist` },
    ]);
  }
  const contract = createContract({
    catalogue: { schemaVersion: "1.0.0", commands: [command] },
    recipes: { schemaVersion: "1.0.0", recipes: [recipe] },
    models: await sources.models.load(),
  });
  return { command, recipe, contract };
}

export async function resolveExecution(command: CommandRecord, sources: ExecutionSources): Promise<ResolvedExecution> {
  const { recipe, contract } = await loadExecutionSnapshot(command, sources);
  const plan = contract.resolveExecutionPlan(command.id);
  const model = contract.findCompatibleModels(command, recipe).find((item) => item.id === plan.modelId);
  const adapter = recipe.modelAdapters.find((item) => item.modelRef === plan.modelId && item.status === "approved");
  // resolveExecutionPlan only returns a compatible model with an approved adapter; guard anyway.
  if (!model || !adapter) throw new ContractResolutionError("NO_APPROVED_MODEL", `${recipe.recipeId} has no approved model`);
  return { command, recipe, model, adapter, plan };
}
