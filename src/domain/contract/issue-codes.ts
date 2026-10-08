// Every issue the contract validators can report, one code per rule. Validators can only emit codes
// listed here (IssueCode is derived from this object), and tests/contract.test.mjs requires at least
// one failing fixture per code. A code can still stand for more than one input shape (for example
// both directions of a mismatch); the shapes swept in that test file are listed in docs/contracts.md.

export const ISSUE_CODES = {
  // JSON Schema (json-schema.ts)
  SCHEMA_TYPE: "value has the wrong JSON type",
  SCHEMA_REQUIRED: "required property is missing",
  SCHEMA_ADDITIONAL_PROPERTY: "property is not defined by the schema",
  SCHEMA_ENUM: "value is not one of the allowed values",
  SCHEMA_CONST: "value differs from the required constant",
  SCHEMA_PATTERN: "string does not match the required pattern",
  SCHEMA_MIN_LENGTH: "string is too short",
  SCHEMA_MIN_ITEMS: "array has too few items",
  SCHEMA_UNIQUE_ITEMS: "array items are not unique",
  SCHEMA_MINIMUM: "number is below the minimum",
  SCHEMA_MAXIMUM: "number is above the maximum",

  // command catalogue (validate-catalogue.ts)
  PROVIDER_KEY_FORBIDDEN: "recipe/provider key in command metadata",
  PROVIDER_TERM_FORBIDDEN: "command text names a registry provider or model",
  COMMAND_ID_DUPLICATE: "two commands share an id",
  COMMAND_SLASH_DUPLICATE: "two commands share a canonical slash",
  COMMAND_SLASH_ID_MISMATCH: "canonical slash is not / + id",
  ALIAS_COLLIDES_WITH_CANONICAL: "alias equals a canonical slash",
  ALIAS_DUPLICATE: "alias is used more than once",
  BRAND_ALIAS_NOT_CLEARED: "brand alias marked allowed",
  COMMAND_RECIPE_REQUIRED: "seed/curated/validated command without a recipe",
  CANDIDATE_HAS_RECIPE: "candidate command with a recipe",
  SOURCE_IMAGE_COUNT_MISMATCH: "sourceImage and maxSourceImages disagree",
  SOURCE_IMAGE_MIME_MISMATCH: "sourceImage and acceptedMimeTypes disagree",
  RISK_FLAG_SYNTHETIC_MISSING: "command lacks synthetic_visualisation",
  RISK_FLAG_INVENTED_CONTENT_MISSING: "EXPLAIN command lacks invented_content_risk",
  RISK_FLAG_IDENTITY_MISSING: "POLISH command lacks identity_preservation",
  RISK_FLAG_BRAND_MISSING: "command with a brand alias lacks brand_reference",
  EVIDENCE_REFS_REQUIRED: "evidence status other than unverified without refs",
  PROVENANCE_EVIDENCE_REQUIRED: "native/community provenance with unverified evidence",

  // recipes (validate-contract.ts)
  RECIPE_ID_DUPLICATE: "two recipes share an id",
  TRUTH_PRESERVING_PRESERVE_INCOMPLETE: "truth-preserving recipe does not preserve every required characteristic",
  TRUTH_PRESERVING_CHANGE_FORBIDDEN: "truth-preserving recipe may change something outside the allowed set",
  TRUTH_PRESERVING_SOURCE_REQUIRED: "truth-preserving recipe without a required source image",
  RECIPE_UNTESTED_WITH_TESTS: "evaluationStatus untested but tested models listed",
  RECIPE_TESTED_WITHOUT_TESTS: "evaluationStatus other than untested but no tested models",
  RECIPE_LAST_TESTED_MISMATCH: "lastTestedAt is not the latest testedAt",
  PARAMETER_ENUM_WITHOUT_OPTIONS: "enum parameter without options",
  PARAMETER_OPTIONS_ON_NON_ENUM: "non-enum parameter with options",
  PARAMETER_DEFAULT_NOT_IN_OPTIONS: "enum default is not one of the options",
  PARAMETER_DEFAULT_TYPE_MISMATCH: "default does not match the parameter type",
  PARAMETER_NAME_DUPLICATE: "two parameters share a name",
  ADAPTER_DUPLICATE: "two adapters for one model",
  ADAPTER_APPROVED_ON_UNTESTED_RECIPE: "approved adapter on a recipe that is not fixture_tested/benchmarked",
  ADAPTER_APPROVED_WITHOUT_PASS: "approved adapter without a passing test on that model",
  ADAPTER_MODEL_UNRESOLVED: "adapter names a model not in the registry",
  TESTED_MODEL_UNRESOLVED: "test entry names a model not in the registry",
  DATE_INVALID: "date is not a calendar day",

  // models (validate-contract.ts)
  MODEL_ID_DUPLICATE: "two models share an id",
  MODEL_NO_IMAGE_OUTPUT: "model does not output images",
  MODEL_NO_TEXT_INPUT: "model does not take text (every recipe sends a text intent)",
  MODEL_REFERENCE_WITHOUT_IMAGE_INPUT: "reference-image support without image input",
  MODEL_REFERENCE_WITHOUT_COUNT: "reference-image support with maxReferenceImages 0",
  MODEL_COUNT_WITHOUT_REFERENCE: "maxReferenceImages above 0 without reference-image support",
  ALLOWLIST_NOT_ACTIVE: "allowed model that is not active",
  ALLOWLIST_NOT_BENCHMARKED: "allowed model without a passed benchmark",
  ALLOWLIST_NOT_PRIVACY_REVIEWED: "allowed model without an approved privacy review",
  MEASUREMENT_UNKNOWN_HAS_SOURCE: "unknown measurement with a source",
  MEASUREMENT_UNKNOWN_HAS_DATE: "unknown measurement with a date",
  MEASUREMENT_UNKNOWN_HAS_VALUES: "unknown measurement with values",
  MEASUREMENT_SOURCE_MISSING: "listed/measured measurement without a source",
  MEASUREMENT_DATE_MISSING: "listed/measured measurement without a date",
  MEASUREMENT_VALUES_MISSING: "listed/measured measurement without every value field",
  LATENCY_PERCENTILES_INVERTED: "p50 latency above p95",

  // cross-document (validate-contract.ts)
  COMMAND_RECIPE_UNRESOLVED: "command names a recipe that does not exist",
  POLISH_NOT_TRUTH_PRESERVING: "POLISH command with a recipe that is not a truth-preserving edit",
  NON_POLISH_TRUTH_PRESERVING: "non-POLISH command with a truth-preserving recipe",
  COMMAND_RECIPE_INPUT_MISMATCH: "command sourceImage differs from recipe referenceImage",
  MATURITY_CURATED_UNTESTED: "curated command whose recipe is not fixture_tested/benchmarked",
  MATURITY_CURATED_WITHOUT_PASS: "curated command whose recipe has no passing test",
  MATURITY_VALIDATED_WITHOUT_PASS: "validated command whose recipe has no passing test",
  MATURITY_VALIDATED_UNBENCHMARKED: "validated command whose recipe is not benchmarked",
  MATURITY_VALIDATED_WITHOUT_EVIDENCE: "validated command without fixture_tested evidence",
} as const;

export type IssueCode = keyof typeof ISSUE_CODES;
