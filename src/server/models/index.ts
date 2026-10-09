import rawRegistry from "./registry.json" with { type: "json" };
import type { ModelRegistry } from "../../domain/contract/types.ts";
import type { ModelRegistryPort } from "./port.ts";

// The committed registry is the runtime Model Capability source. It is validated together with the
// command and recipe of every generation (src/server/generation/resolve.ts), so an invalid registry
// fails that generation closed instead of being trusted here.
const registry = rawRegistry as ModelRegistry;

export const modelRegistry: ModelRegistryPort = {
  async load() {
    return registry;
  },
};
export type { ModelRegistryPort } from "./port.ts";
