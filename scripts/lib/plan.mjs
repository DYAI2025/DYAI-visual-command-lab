// Resolution for the generation scripts, through the same repositories, registry and resolver the
// route uses (src/server/generation/resolve.ts). Scripts never read catalogue or recipe JSON, so the
// plan a script reports is the plan the server executes.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { commandRepository, recipeRepository } from "../../src/server/catalogue/index.ts";
import { modelRegistry } from "../../src/server/models/index.ts";
import { loadExecutionSnapshot, resolveCommandRef, resolveExecution } from "../../src/server/generation/resolve.ts";

export const sources = { commands: commandRepository, recipes: recipeRepository, models: modelRegistry };

/** The executable plan for a command, or a ContractResolutionError/ContractInvalidError. */
export async function resolvePlan(ref) {
  return resolveExecution(await resolveCommandRef(ref, sources.commands), sources);
}

/**
 * What a qualification call needs before the model is approved: the command, its recipe and the
 * model, provided the model is compatible with both. Approval is not required (qualification is the
 * evidence an approval cites), but everything else the route enforces is: a deprecated, candidate or
 * invalid command throws exactly as it would on the route.
 */
export async function qualificationTarget(ref, modelId) {
  const command = await resolveCommandRef(ref, sources.commands);
  const { recipe, contract } = await loadExecutionSnapshot(command, sources);
  const model = contract.findCompatibleModels(command, recipe).find((item) => item.id === modelId) ?? null;
  return { command, recipe, model };
}

/** True when dir is outside the project directory (not the directory itself, not below it). */
export function outsideRepository(dir) {
  const relative = path.relative(fs.realpathSync("."), path.resolve(dir));
  return path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`);
}

/**
 * The commit this checkout is at, and whether the working tree has any change. Throws unless the
 * current directory is the root of its own git checkout (an exported tree nested in another
 * repository must not report that repository's commit).
 */
export function gitState() {
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  if (fs.realpathSync(top) !== fs.realpathSync(".")) throw new Error(`not a git checkout root (toplevel ${top})`);
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
