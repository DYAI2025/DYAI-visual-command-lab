import { ContractResolutionError, createContract, type ExecutionPlan } from "../../domain/contract/contract.ts";
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
// A snapshot that fails validation is not executed (ContractInvalidError propagates).

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

export async function resolveExecution(command: CommandRecord, sources: ExecutionSources): Promise<ResolvedExecution> {
  if (command.maturity === "deprecated") {
    throw new ContractResolutionError("COMMAND_NOT_EXECUTABLE", `${command.canonicalSlash} is deprecated`);
  }
  const recipe = command.recipeId === null ? null : await sources.recipes.getById(command.recipeId);
  if (!recipe) {
    throw new ContractResolutionError(
      "RECIPE_NOT_ASSIGNED",
      `${command.canonicalSlash} (maturity ${command.maturity}) has no executable recipe`,
    );
  }
  const registry = await sources.models.load();
  const snapshot = createContract({
    catalogue: { schemaVersion: "1.0.0", commands: [command] },
    recipes: { schemaVersion: "1.0.0", recipes: [recipe] },
    models: registry,
  });
  const plan = snapshot.resolveExecutionPlan(command.id);
  const model = snapshot.findCompatibleModels(command, recipe).find((item) => item.id === plan.modelId);
  const adapter = recipe.modelAdapters.find((item) => item.modelRef === plan.modelId && item.status === "approved");
  // resolveExecutionPlan only returns a compatible model with an approved adapter; guard anyway.
  if (!model || !adapter) throw new ContractResolutionError("NO_APPROVED_MODEL", `${recipe.recipeId} has no approved model`);
  return { command, recipe, model, adapter, plan };
}
