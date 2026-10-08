import type { Recipe } from "../../domain/contract/types.ts";
import { GenerationRequestError } from "./request.ts";

const words = (items: readonly string[]) => items.map((item) => item.replaceAll("_", " ")).join(", ");

/**
 * Checks caller-supplied values against the recipe's declared parameters and fills defaults. Unknown
 * names, values outside an enum, and missing required parameters are rejected.
 */
export function resolveParameters(recipe: Recipe, values: Record<string, string>): Record<string, string> {
  const declared = new Map(recipe.parameters.map((parameter) => [parameter.name, parameter]));
  for (const name of Object.keys(values)) {
    if (!declared.has(name)) throw new GenerationRequestError(400, "invalid_parameters");
  }
  const resolved: Record<string, string> = {};
  for (const parameter of recipe.parameters) {
    const value = Object.hasOwn(values, parameter.name) ? values[parameter.name] : parameter.default;
    if (value === undefined) {
      if (parameter.required) throw new GenerationRequestError(400, "invalid_parameters");
      continue;
    }
    const text = String(value);
    const valid =
      parameter.type === "enum"
        ? (parameter.options ?? []).includes(text)
        : parameter.type === "number"
          ? /^-?\d+(\.\d+)?$/.test(text)
          : parameter.type === "boolean"
            ? text === "true" || text === "false"
            : text.length <= 200;
    if (!valid) throw new GenerationRequestError(400, "invalid_parameters");
    resolved[parameter.name] = text;
  }
  return resolved;
}

/**
 * Builds the provider instruction from the recipe (server-only). The command catalogue and the UI
 * never contribute prompt text; adapter overrides come from the approved recipe adapter.
 */
export function composePrompt(recipe: Recipe, promptOverrides: readonly string[], parameters: Record<string, string>): string {
  const lines = [recipe.baseIntent];
  const described = recipe.parameters.filter((parameter) => Object.hasOwn(parameters, parameter.name));
  if (described.length > 0) {
    lines.push("Settings:");
    for (const parameter of described) lines.push(`- ${parameter.name}: ${parameters[parameter.name]} (${parameter.description})`);
  }
  if (recipe.preserve.length > 0) lines.push(`Preserve from the reference image: ${words(recipe.preserve)}.`);
  if (recipe.immutableFeatures.length > 0) lines.push(`Keep unchanged: ${recipe.immutableFeatures.join("; ")}.`);
  if (recipe.mayChange.length > 0) lines.push(`You may change: ${words(recipe.mayChange)}.`);
  if (recipe.constraints.length > 0) {
    lines.push("Constraints:");
    for (const constraint of recipe.constraints) lines.push(`- ${constraint}`);
  }
  if (recipe.negativeConstraints.length > 0) {
    lines.push("Never:");
    for (const constraint of recipe.negativeConstraints) lines.push(`- ${constraint}`);
  }
  for (const override of promptOverrides) lines.push(override);
  lines.push("Return exactly one image.");
  return lines.join("\n");
}
