// Positive control for the runtime smoke. The committed registry has no approved model, so
// scripts/runtime-smoke.mjs cannot reach its success, budget-exhaustion, cost-telemetry and
// provider-failure scenarios on a committed tree. This script exports HEAD into a temporary
// directory, applies the TEST-ONLY approval overlay (scripts/lib/approval-overlay.mjs) to that copy's
// recipe book and model registry, builds it (prebuild validates the overlaid contract), and runs the
// runtime smoke there against the loopback stub provider. Every scenario must run and pass.
//
// The overlay never touches this checkout and no real provider is called. The result proves the
// route/runtime boundary (budget, quota, kill switch, sanitized failures, telemetry) of HEAD's code;
// it does not approve a model and is not real-provider evidence.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyTestApproval } from "./lib/approval-overlay.mjs";
import { gitState } from "./lib/plan.mjs";

const head = gitState();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dyai-positive-control-"));
const run = (cmd, args, options = {}) => {
  const result = spawnSync(cmd, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...options });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};

let exitCode = 1;
try {
  const tar = path.join(dir, "head.tar");
  execFileSync("git", ["archive", "--format=tar", "-o", tar, "HEAD"]);
  execFileSync("tar", ["-xf", tar, "-C", dir]);
  fs.rmSync(tar);
  // A real copy (copy-on-write where the filesystem supports it): Turbopack refuses node_modules
  // symlinked from outside the project root.
  fs.cpSync("node_modules", path.join(dir, "node_modules"), { recursive: true, mode: fs.constants.COPYFILE_FICLONE, verbatimSymlinks: true });

  const recipesFile = path.join(dir, "src/server/recipes/recipes.json");
  const registryFile = path.join(dir, "src/server/models/registry.json");
  const bundle = { recipes: JSON.parse(fs.readFileSync(recipesFile, "utf8")), models: JSON.parse(fs.readFileSync(registryFile, "utf8")) };
  applyTestApproval(bundle);
  fs.writeFileSync(recipesFile, `${JSON.stringify(bundle.recipes, null, 2)}\n`);
  fs.writeFileSync(registryFile, `${JSON.stringify(bundle.models, null, 2)}\n`);

  const build = run(process.execPath, ["node_modules/next/dist/bin/next", "build"], { env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
  if (build.status !== 0) {
    console.error(build.output);
    throw new Error(`positive-control build failed (${build.status})`);
  }
  const validate = run(process.execPath, ["scripts/validate-contract.mjs"]);
  if (validate.status !== 0) {
    console.error(validate.output);
    throw new Error("overlaid contract does not validate");
  }

  const smoke = run(process.execPath, ["scripts/runtime-smoke.mjs"], { env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  console.log(smoke.output.trim());
  const notRun = (smoke.output.match(/^NOT RUN/gm) ?? []).length;
  const ok = smoke.status === 0 && notRun === 0 && /executable plan: \/actionfigure -> /.test(smoke.output);
  console.log(
    `positive-control: ${ok ? "PASS" : "FAIL"} on HEAD ${head.sha}${head.clean ? "" : " (working tree not clean: HEAD exported, local changes not included)"}; ` +
      `test-only approval overlay on an exported copy; smoke rc ${smoke.status}, ${notRun} not run`,
  );
  exitCode = ok ? 0 : 1;
} catch (error) {
  console.error(`positive-control: ${error.message}`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(exitCode);
