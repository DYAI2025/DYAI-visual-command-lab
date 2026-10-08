import fs from "node:fs";
import { validateContract } from "../src/domain/contract/validate-contract.ts";

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const files = {
  catalogue: "src/domain/commands/catalogue.json",
  recipes: "src/server/recipes/recipes.json",
  models: "src/server/models/registry.json",
};

const issues = validateContract({
  catalogue: read(files.catalogue),
  recipes: read(files.recipes),
  models: read(files.models),
});

if (issues.length > 0) {
  console.error(`Visual Command contract invalid (${issues.length} issue(s)):`);
  for (const issue of issues) console.error(`  ${issue.code} ${issue.path}: ${issue.message}`);
  process.exit(1);
}

const { commands } = read(files.catalogue);
const { recipes } = read(files.recipes);
const { models } = read(files.models);
console.log(
  `Visual Command contract valid: ${commands.length} commands, ${recipes.length} recipes, ${models.length} model capabilities.`,
);
