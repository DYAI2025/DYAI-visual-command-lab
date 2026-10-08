import rawCatalogue from "./catalogue.json" with { type: "json" };
import { assertValidCatalogue } from "../contract/validate-catalogue.ts";
import type { CommandRecord } from "../contract/types.ts";

export type { CommandRecord, Lane } from "../contract/types.ts";

// UI-facing command metadata. Validated against the catalogue rules when the module loads, so a
// catalogue that breaks them fails the build instead of rendering. Recipes and model capabilities
// are server-only (src/server).
export const commandCatalogue: readonly CommandRecord[] = assertValidCatalogue(rawCatalogue).commands;

export function getCommandById(id: string) {
  return commandCatalogue.find((command) => command.id === id);
}

/** Canonical slash or a publicly allowed alias; review-gated brand aliases do not resolve. */
export function findPublicCommand(slash: string) {
  return (
    commandCatalogue.find((command) => command.canonicalSlash === slash) ??
    commandCatalogue.find((command) =>
      command.aliases.some((alias) => alias.slash === slash && alias.publicUse === "allowed"),
    )
  );
}
