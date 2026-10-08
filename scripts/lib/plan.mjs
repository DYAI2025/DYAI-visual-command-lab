// Resolution for the generation scripts, through the same repositories, registry and resolver the
// route uses (src/server/generation/resolve.ts). Scripts never read catalogue or recipe JSON, so the
// plan a script reports is the plan the server executes.

import { execFileSync } from "node:child_process";
import fs from "node:fs";

import { createContract } from "../../src/domain/contract/contract.ts";
import { commandRepository, recipeRepository } from "../../src/server/catalogue/index.ts";
import { modelRegistry } from "../../src/server/models/index.ts";
import { resolveCommandRef, resolveExecution } from "../../src/server/generation/resolve.ts";

export const sources = { commands: commandRepository, recipes: recipeRepository, models: modelRegistry };

/** The executable plan for a command, or a ContractResolutionError/ContractInvalidError. */
export async function resolvePlan(ref) {
  return resolveExecution(await resolveCommandRef(ref, sources.commands), sources);
}

/**
 * What a qualification call needs before the model is approved: the command, its recipe and the
 * model, provided the model is compatible with both. Approval is not required (qualification is the
 * evidence an approval cites).
 */
export async function qualificationTarget(ref, modelId) {
  const command = await resolveCommandRef(ref, sources.commands);
  const recipe = command.recipeId === null ? null : await sources.recipes.getById(command.recipeId);
  if (!recipe) return { command, recipe: null, model: null };
  const snapshot = createContract({
    catalogue: { schemaVersion: "1.0.0", commands: [command] },
    recipes: { schemaVersion: "1.0.0", recipes: [recipe] },
    models: await sources.models.load(),
  });
  const model = snapshot.findCompatibleModels(command, recipe).find((item) => item.id === modelId) ?? null;
  return { command, recipe, model };
}

/** The commit this checkout is at, and whether the working tree has any change. */
export function gitState() {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }).trim();
  return { sha, clean: dirty === "" };
}

/** The commit the production build in .next was made from (written by scripts/record-build-source.mjs). */
export function buildSource() {
  try {
    return JSON.parse(fs.readFileSync(".next/dyai-build-source.json", "utf8"));
  } catch {
    return null;
  }
}
