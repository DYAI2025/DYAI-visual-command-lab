import type { ModelRegistry } from "../../domain/contract/types.ts";

/**
 * Model Capability runtime registry. Separate from authoring persistence (ADR-0001, DYAI-39
 * invariant 3): Commands and Recipes come from the catalogue repositories, models only from here.
 */
export interface ModelRegistryPort {
  load(): Promise<ModelRegistry>;
}
