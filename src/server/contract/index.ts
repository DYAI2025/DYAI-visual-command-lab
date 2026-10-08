import catalogue from "../../domain/commands/catalogue.json" with { type: "json" };
import recipes from "../recipes/recipes.json" with { type: "json" };
import models from "../models/registry.json" with { type: "json" };
import { createContract } from "../../domain/contract/contract.ts";

export { ContractInvalidError, ContractResolutionError } from "../../domain/contract/contract.ts";
export type { ExecutionContract, ExecutionPlan } from "../../domain/contract/contract.ts";

// Server-side view of Command -> Recipe -> Model Capability. Validated when the module loads;
// an invalid combination throws instead of serving a partially valid contract.
export const executionContract = createContract({ catalogue, recipes, models });
