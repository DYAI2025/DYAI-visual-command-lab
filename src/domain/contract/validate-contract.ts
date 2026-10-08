import recipeSchema from "./schemas/recipe-book.schema.json" with { type: "json" };
import modelSchema from "./schemas/model-registry.schema.json" with { type: "json" };
import { validateAgainstSchema } from "./json-schema.ts";
import { validateCatalogue } from "./validate-catalogue.ts";
import type { IssueCode } from "./issue-codes.ts";
import type {
  AdjustableCharacteristic,
  CommandCatalogue,
  ContractBundle,
  ContractIssue,
  CostMeasurement,
  LatencyMeasurement,
  ModelRegistry,
  PreservedCharacteristic,
  Recipe,
  RecipeBook,
} from "./types.ts";

// POLISH default (04.1 §4): what a truth-preserving edit must keep, and the only things it may change.
export const TRUTH_PRESERVING_MUST_PRESERVE: readonly PreservedCharacteristic[] = [
  "subject_identity",
  "people",
  "object_identity",
  "geometry",
  "logos_text",
  "visible_defects",
  "material_characteristics",
];

export const TRUTH_PRESERVING_MAY_CHANGE: readonly AdjustableCharacteristic[] = [
  "exposure",
  "tonal_treatment",
  "colour_treatment",
  "perceived_lighting",
  "contrast",
  "sharpness_treatment",
  "film_character",
  "atmosphere_depth",
];

// Recipe evaluation states that count as test evidence.
const TESTED = new Set<Recipe["evaluationStatus"]>(["fixture_tested", "benchmarked"]);

const hasSchemaIssues = (issues: ContractIssue[]) => issues.some((issue) => issue.code.startsWith("SCHEMA_"));
const hasPass = (recipe: Recipe, modelRef?: string) =>
  recipe.testedModels.some((entry) => entry.result === "pass" && (modelRef === undefined || entry.modelRef === modelRef));

/** YYYY-MM-DD that names a real calendar day. */
export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day); // unlike Date.UTC, keeps years 0-99 as written
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function checkDate(value: string | null, path: string, issues: ContractIssue[]) {
  if (value !== null && !isCalendarDate(value)) {
    issues.push({ code: "DATE_INVALID", path, message: `${value} is not a calendar day` });
  }
}

function checkMeasurement(
  measurement: CostMeasurement | LatencyMeasurement,
  valueFields: readonly string[],
  path: string,
  issues: ContractIssue[],
) {
  const push = (code: IssueCode, message: string) => issues.push({ code, path, message });
  const present = valueFields.filter((field) => Object.hasOwn(measurement, field));
  if (measurement.status === "unknown") {
    if (measurement.source !== null) push("MEASUREMENT_UNKNOWN_HAS_SOURCE", "unknown measurement names a source");
    if (measurement.observedAt !== null) push("MEASUREMENT_UNKNOWN_HAS_DATE", "unknown measurement has a date");
    if (present.length > 0) push("MEASUREMENT_UNKNOWN_HAS_VALUES", `unknown measurement carries ${present.join(", ")}`);
  } else {
    if (measurement.source === null) push("MEASUREMENT_SOURCE_MISSING", `${measurement.status} needs a source`);
    if (measurement.observedAt === null) push("MEASUREMENT_DATE_MISSING", `${measurement.status} needs a date`);
    if (present.length !== valueFields.length) push("MEASUREMENT_VALUES_MISSING", `${measurement.status} needs ${valueFields.join(", ")}`);
  }
  checkDate(measurement.observedAt, `${path}/observedAt`, issues);
}

function validateModels(models: unknown): ContractIssue[] {
  const issues: ContractIssue[] = validateAgainstSchema(modelSchema, models);
  if (hasSchemaIssues(issues)) return issues;

  const seen = new Set<string>();
  (models as ModelRegistry).models.forEach((model, index) => {
    const at = (field: string) => `/models/${index}${field}`;
    const push = (code: IssueCode, field: string, message: string) => issues.push({ code, path: at(field), message });
    if (seen.has(model.id)) push("MODEL_ID_DUPLICATE", "/id", `duplicate model ${model.id}`);
    seen.add(model.id);

    const { inputModalities, outputModalities, referenceImage, maxReferenceImages } = model.capabilities;
    if (!outputModalities.includes("image")) push("MODEL_NO_IMAGE_OUTPUT", "/capabilities/outputModalities", "no image output");
    if (!inputModalities.includes("text")) push("MODEL_NO_TEXT_INPUT", "/capabilities/inputModalities", "no text input");
    if (referenceImage && !inputModalities.includes("image")) {
      push("MODEL_REFERENCE_WITHOUT_IMAGE_INPUT", "/capabilities/inputModalities", "reference images need image input");
    }
    if (referenceImage && maxReferenceImages < 1) {
      push("MODEL_REFERENCE_WITHOUT_COUNT", "/capabilities/maxReferenceImages", "reference images need a count of at least 1");
    }
    if (!referenceImage && maxReferenceImages > 0) {
      push("MODEL_COUNT_WITHOUT_REFERENCE", "/capabilities/maxReferenceImages", "count set without reference-image support");
    }

    if (model.allowlist === "allowed") {
      if (model.lifecycle !== "active") push("ALLOWLIST_NOT_ACTIVE", "/allowlist", `lifecycle is ${model.lifecycle}`);
      if (model.benchmarkStatus !== "passed") push("ALLOWLIST_NOT_BENCHMARKED", "/allowlist", `benchmark is ${model.benchmarkStatus}`);
      if (model.policy.privacyReview !== "approved") {
        push("ALLOWLIST_NOT_PRIVACY_REVIEWED", "/allowlist", `privacy review is ${model.policy.privacyReview}`);
      }
    }

    checkMeasurement(
      model.cost,
      ["inputUsdPerMillionTokens", "textOutputUsdPerMillionTokens", "imageOutputUsdPerMillionTokens"],
      at("/cost"),
      issues,
    );
    checkMeasurement(model.latency, ["p50Ms", "p95Ms"], at("/latency"), issues);
    const { p50Ms, p95Ms } = model.latency;
    if (p50Ms !== undefined && p95Ms !== undefined && p50Ms > p95Ms) {
      push("LATENCY_PERCENTILES_INVERTED", "/latency", `p50 ${p50Ms} ms above p95 ${p95Ms} ms`);
    }
  });
  return issues;
}

function validateRecipes(recipes: unknown, modelIds: ReadonlySet<string> | null): ContractIssue[] {
  const issues: ContractIssue[] = validateAgainstSchema(recipeSchema, recipes);
  if (hasSchemaIssues(issues)) return issues;

  const seen = new Set<string>();
  (recipes as RecipeBook).recipes.forEach((recipe, index) => {
    const at = (field: string) => `/recipes/${index}${field}`;
    const push = (code: IssueCode, field: string, message: string) => issues.push({ code, path: at(field), message });
    if (seen.has(recipe.recipeId)) push("RECIPE_ID_DUPLICATE", "/recipeId", `duplicate recipe ${recipe.recipeId}`);
    seen.add(recipe.recipeId);

    if (recipe.truthMode === "truth_preserving_edit") {
      const missing = TRUTH_PRESERVING_MUST_PRESERVE.filter((item) => !recipe.preserve.includes(item));
      if (missing.length > 0) push("TRUTH_PRESERVING_PRESERVE_INCOMPLETE", "/preserve", `must preserve ${missing.join(", ")}`);
      const forbidden = recipe.mayChange.filter((item) => !TRUTH_PRESERVING_MAY_CHANGE.includes(item));
      if (forbidden.length > 0) push("TRUTH_PRESERVING_CHANGE_FORBIDDEN", "/mayChange", `may not change ${forbidden.join(", ")}`);
      if (recipe.inputs.referenceImage !== "required") {
        push("TRUTH_PRESERVING_SOURCE_REQUIRED", "/inputs/referenceImage", "needs a required source image to preserve");
      }
    }

    recipe.testedModels.forEach((entry, i) => checkDate(entry.testedAt, at(`/testedModels/${i}/testedAt`), issues));
    checkDate(recipe.lastTestedAt, at("/lastTestedAt"), issues);
    const tested = recipe.testedModels.length > 0;
    if (recipe.evaluationStatus === "untested" && tested) {
      push("RECIPE_UNTESTED_WITH_TESTS", "/evaluationStatus", "untested recipe lists tested models");
    }
    if (recipe.evaluationStatus !== "untested" && !tested) {
      push("RECIPE_TESTED_WITHOUT_TESTS", "/evaluationStatus", `${recipe.evaluationStatus} recipe lists no tested models`);
    }
    const latest = tested ? recipe.testedModels.map((entry) => entry.testedAt).sort().at(-1) : null;
    if (recipe.lastTestedAt !== latest) {
      push("RECIPE_LAST_TESTED_MISMATCH", "/lastTestedAt", `expected ${latest ?? "null"}`);
    }

    const parameterNames = new Set<string>();
    recipe.parameters.forEach((parameter, i) => {
      const field = `/parameters/${i}`;
      if (parameter.type === "enum" && (parameter.options?.length ?? 0) === 0) {
        push("PARAMETER_ENUM_WITHOUT_OPTIONS", field, `${parameter.name} has no options`);
      }
      if (parameter.type !== "enum" && parameter.options !== undefined) {
        push("PARAMETER_OPTIONS_ON_NON_ENUM", field, `${parameter.name} is ${parameter.type} but lists options`);
      }
      if (parameter.default !== undefined) {
        const expectedType = parameter.type === "enum" ? "string" : parameter.type;
        if (typeof parameter.default !== expectedType) {
          push("PARAMETER_DEFAULT_TYPE_MISMATCH", field, `${parameter.name} default is not a ${expectedType}`);
        } else if (parameter.type === "enum" && !(parameter.options ?? []).includes(String(parameter.default))) {
          push("PARAMETER_DEFAULT_NOT_IN_OPTIONS", field, `${parameter.name} default is not an option`);
        }
      }
      if (parameterNames.has(parameter.name)) push("PARAMETER_NAME_DUPLICATE", field, `duplicate parameter ${parameter.name}`);
      parameterNames.add(parameter.name);
    });

    const adapterRefs = new Set<string>();
    recipe.modelAdapters.forEach((adapter, i) => {
      const field = `/modelAdapters/${i}`;
      if (adapterRefs.has(adapter.modelRef)) push("ADAPTER_DUPLICATE", field, `more than one adapter for ${adapter.modelRef}`);
      adapterRefs.add(adapter.modelRef);
      if (adapter.status === "approved") {
        if (!TESTED.has(recipe.evaluationStatus)) {
          push("ADAPTER_APPROVED_ON_UNTESTED_RECIPE", `${field}/status`, `recipe is ${recipe.evaluationStatus}`);
        }
        if (!hasPass(recipe, adapter.modelRef)) {
          push("ADAPTER_APPROVED_WITHOUT_PASS", `${field}/status`, `no passing test on ${adapter.modelRef}`);
        }
      }
      if (modelIds && !modelIds.has(adapter.modelRef)) {
        push("ADAPTER_MODEL_UNRESOLVED", `${field}/modelRef`, `unknown model ${adapter.modelRef}`);
      }
    });
    if (modelIds) {
      recipe.testedModels.forEach((entry, i) => {
        if (!modelIds.has(entry.modelRef)) {
          push("TESTED_MODEL_UNRESOLVED", `/testedModels/${i}/modelRef`, `unknown model ${entry.modelRef}`);
        }
      });
    }
  });
  return issues;
}

/**
 * Validates catalogue, recipes and model registry together. Each document is checked against its
 * schema first; semantic and cross-document rules that read a document run once it is schema-valid
 * (the catalogue provider scan runs regardless). Issue paths are JSON pointers into their own
 * document (/commands/..., /recipes/..., /models/...).
 */
export function validateContract(bundle: ContractBundle): ContractIssue[] {
  const modelIssues = validateModels(bundle.models);
  const modelsValid = !hasSchemaIssues(modelIssues);
  const models = modelsValid ? (bundle.models as ModelRegistry).models : [];
  const providerTerms = models.flatMap((model) => [
    model.provider,
    model.id,
    model.providerModelId,
    model.id.slice(model.id.indexOf("/") + 1),
    model.providerModelId.slice(model.providerModelId.indexOf("/") + 1),
  ]);

  const recipeIssues = validateRecipes(bundle.recipes, modelsValid ? new Set(models.map((model) => model.id)) : null);
  const catalogueIssues = validateCatalogue(bundle.catalogue, { providerTerms });

  const issues = [...catalogueIssues, ...recipeIssues, ...modelIssues];
  if (hasSchemaIssues(catalogueIssues) || hasSchemaIssues(recipeIssues)) return issues;

  const recipes = new Map((bundle.recipes as RecipeBook).recipes.map((recipe) => [recipe.recipeId, recipe]));
  (bundle.catalogue as CommandCatalogue).commands.forEach((command, index) => {
    if (command.recipeId === null) return;
    const at = (field: string) => `/commands/${index}${field}`;
    const push = (code: IssueCode, field: string, message: string) => issues.push({ code, path: at(field), message });
    const recipe = recipes.get(command.recipeId);
    if (!recipe) {
      push("COMMAND_RECIPE_UNRESOLVED", "/recipeId", `recipe ${command.recipeId} does not exist`);
      return;
    }
    const truthPreserving = recipe.truthMode === "truth_preserving_edit";
    if (command.lane === "polish" && !truthPreserving) {
      push("POLISH_NOT_TRUTH_PRESERVING", "/recipeId", `recipe truth mode is ${recipe.truthMode}`);
    }
    if (command.lane !== "polish" && truthPreserving) {
      push("NON_POLISH_TRUTH_PRESERVING", "/recipeId", `lane ${command.lane} with a truth-preserving recipe`);
    }
    if (command.inputRequirements.sourceImage !== recipe.inputs.referenceImage) {
      push(
        "COMMAND_RECIPE_INPUT_MISMATCH",
        "/inputRequirements/sourceImage",
        `command ${command.inputRequirements.sourceImage} vs recipe ${recipe.inputs.referenceImage}`,
      );
    }
    if (command.maturity === "curated") {
      if (!TESTED.has(recipe.evaluationStatus)) push("MATURITY_CURATED_UNTESTED", "/maturity", `recipe is ${recipe.evaluationStatus}`);
      if (!hasPass(recipe)) push("MATURITY_CURATED_WITHOUT_PASS", "/maturity", "recipe has no passing test");
    }
    if (command.maturity === "validated") {
      if (!hasPass(recipe)) push("MATURITY_VALIDATED_WITHOUT_PASS", "/maturity", "recipe has no passing test");
      if (recipe.evaluationStatus !== "benchmarked") {
        push("MATURITY_VALIDATED_UNBENCHMARKED", "/maturity", `recipe is ${recipe.evaluationStatus}`);
      }
      if (command.evidence.status !== "fixture_tested") {
        push("MATURITY_VALIDATED_WITHOUT_EVIDENCE", "/maturity", `evidence is ${command.evidence.status}`);
      }
    }
  });
  return issues;
}
