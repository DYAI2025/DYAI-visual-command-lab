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

/**
 * True when dir is outside the project directory (not the directory itself, not below it). Symlinks
 * are resolved through the nearest existing ancestor, so a link into the project does not count as
 * outside it.
 */
export function outsideRepository(dir) {
  let existing = path.resolve(dir);
  const rest = [];
  while (!fs.existsSync(existing)) {
    rest.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  const relative = path.relative(fs.realpathSync("."), path.join(fs.realpathSync(existing), ...rest));
  return path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`);
}

/** Where the live scripts record their runs (metadata and hashes only). */
export const EVIDENCE_DIR = "docs/evidence/dyai-37";

/** The recorded runs whose file name starts with prefix ("qualification-", "live-route-"). */
export function evidenceRecords(prefix) {
  if (!fs.existsSync(EVIDENCE_DIR)) return [];
  return fs
    .readdirSync(EVIDENCE_DIR)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .map((name) => ({ file: path.join(EVIDENCE_DIR, name), ...JSON.parse(fs.readFileSync(path.join(EVIDENCE_DIR, name), "utf8")) }));
}

/**
 * True when HEAD carries the same code as commit sha: nothing changed outside docs/evidence since.
 * A run recorded there is a run of this candidate, so committing its evidence does not license a
 * second paid call. An unknown commit counts as the same code (fail closed).
 */
export function sameCodeAs(sha) {
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) return true;
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" });
  } catch {
    return true;
  }
  try {
    execFileSync("git", ["diff", "--quiet", sha, "HEAD", "--", ".", `:(exclude)${EVIDENCE_DIR}`], { stdio: "ignore" });
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

/** Writes a run record, first as `incomplete` before the paid call, then with its outcome. */
export function writeEvidence(file, record, secrets) {
  const serialized = JSON.stringify(record, null, 2);
  if (secrets.some((secret) => secret && serialized.includes(secret))) throw new Error("refusing to write evidence containing a credential");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${serialized}\n`);
  return serialized;
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
