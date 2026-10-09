import { catalogueBinding } from "../catalogue/index.ts";
import { CatalogueStoreError } from "../persistence/errors.ts";
import type { AuthoringRepository } from "./port.ts";

/**
 * The operator authoring repository of the configured durable store. Authoring needs durable
 * persistence: with the static bootstrap adapter it fails closed (AUTHORING_UNAVAILABLE) rather than
 * pretending writes could last. Server code only.
 */
export async function authoringRepository(): Promise<AuthoringRepository> {
  const bound = await catalogueBinding();
  if (!bound.store) {
    throw new CatalogueStoreError("AUTHORING_UNAVAILABLE", "authoring needs COMMAND_STORE_ADAPTER=sqlite with a migrated DATABASE_URL");
  }
  return bound.store.authoring;
}

export { AUTHORING_LIFECYCLES } from "./port.ts";
export type {
  AuthoredCommand,
  AuthoringLifecycle,
  AuthoringRepository,
  CategoryInput,
  CommandQuery,
  CommandRevision,
  RecipeVersionResult,
} from "./port.ts";
