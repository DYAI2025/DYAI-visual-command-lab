import type { ContractIssue } from "../../domain/contract/types.ts";

/**
 * Why the authoring catalogue store refused or could not serve. Configuration and availability codes
 * mean the configured store cannot be used at all (the runtime fails closed, never falls back to the
 * static bootstrap data); the others reject a single write or read.
 */
export type CatalogueStoreErrorCode =
  // configuration / availability
  | "CONFIG_INVALID"
  | "DATABASE_MISSING"
  | "SCHEMA_NOT_MIGRATED"
  | "SCHEMA_DRIFT"
  | "DATABASE_CORRUPT"
  | "AUTHORING_UNAVAILABLE"
  // write validation
  | "VALIDATION_FAILED"
  | "FORBIDDEN_CONTENT"
  | "COMMAND_ID_CONFLICT"
  | "SLASH_CONFLICT"
  | "COMMAND_NOT_FOUND"
  | "NOT_EDITABLE"
  | "REVISION_CONFLICT"
  | "LIFECYCLE_INVALID"
  | "LIFECYCLE_TRANSITION_FORBIDDEN"
  | "RECIPE_NOT_FOUND"
  | "RECIPE_VERSION_CONFLICT"
  | "RECIPE_VERSION_NOT_NEWER"
  | "RECIPE_VERSION_NOT_CURRENT"
  | "RECIPE_IN_ACTIVE_USE"
  | "CATEGORY_NOT_FOUND"
  | "CATEGORY_ARCHIVED"
  | "CATEGORY_CONFLICT"
  // seed import
  | "IMPORT_SOURCE_INVALID"
  | "IMPORT_CONFLICT";

const UNAVAILABLE = new Set<CatalogueStoreErrorCode>([
  "CONFIG_INVALID",
  "DATABASE_MISSING",
  "SCHEMA_NOT_MIGRATED",
  "SCHEMA_DRIFT",
  "DATABASE_CORRUPT",
  "AUTHORING_UNAVAILABLE",
]);

export class CatalogueStoreError extends Error {
  readonly code: CatalogueStoreErrorCode;
  readonly issues: readonly ContractIssue[];
  readonly conflicts: readonly string[];

  constructor(
    code: CatalogueStoreErrorCode,
    message: string,
    detail: { issues?: readonly ContractIssue[]; conflicts?: readonly string[] } = {},
  ) {
    super(`${code}: ${message}`);
    this.name = "CatalogueStoreError";
    this.code = code;
    this.issues = detail.issues ?? [];
    this.conflicts = detail.conflicts ?? [];
  }

  /** The configured store cannot serve at all (as opposed to one rejected write). */
  get unavailable(): boolean {
    return UNAVAILABLE.has(this.code);
  }
}
