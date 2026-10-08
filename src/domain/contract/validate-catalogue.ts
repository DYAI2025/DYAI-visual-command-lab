import catalogueSchema from "./schemas/command-catalogue.schema.json" with { type: "json" };
import { pointerToken, validateAgainstSchema } from "./json-schema.ts";
import type { IssueCode } from "./issue-codes.ts";
import type { CommandCatalogue, CommandRecord, ContractIssue, RiskFlag } from "./types.ts";

// Keys that belong to recipes, model adapters or providers. They must never appear in
// UI-facing command metadata, at any depth.
const PROVIDER_KEYS = new Set([
  "prompt",
  "prompts",
  "systemPrompt",
  "negativePrompt",
  "promptOverrides",
  "baseIntent",
  "model",
  "models",
  "modelId",
  "modelRef",
  "modelAdapters",
  "provider",
  "providerModelId",
  "apiKey",
]);

const EXECUTABLE_WITHOUT_RECIPE = new Set(["candidate", "deprecated"]);

function requiredRiskFlags(command: CommandRecord): [RiskFlag, IssueCode][] {
  const flags: [RiskFlag, IssueCode][] = [["synthetic_visualisation", "RISK_FLAG_SYNTHETIC_MISSING"]];
  if (command.lane === "explain") flags.push(["invented_content_risk", "RISK_FLAG_INVENTED_CONTENT_MISSING"]);
  if (command.lane === "polish") flags.push(["identity_preservation", "RISK_FLAG_IDENTITY_MISSING"]);
  if (command.aliases.some((alias) => alias.kind === "brand_term")) flags.push(["brand_reference", "RISK_FLAG_BRAND_MISSING"]);
  return flags;
}

// evidence.refs hold citations (URLs, report names); they may name a vendor and are not scanned for terms.
const isCitation = (path: string) => /^\/commands\/\d+\/evidence\/refs\/\d+$/.test(path);

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function providerTermPattern(terms: readonly string[]): RegExp | null {
  const unique = [...new Set(terms.map((term) => term.trim().toLowerCase()).filter(Boolean))];
  if (unique.length === 0) return null;
  const alternatives = unique.sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
  return new RegExp(`(?<![a-z0-9])(?:${alternatives})(?![a-z0-9])`, "iu");
}

function findProviderDetails(node: unknown, path: string, terms: RegExp | null, issues: ContractIssue[]) {
  if (typeof node === "string") {
    const hit = isCitation(path) ? null : terms?.exec(node);
    if (hit) {
      issues.push({ code: "PROVIDER_TERM_FORBIDDEN", path, message: `names provider/model "${hit[0]}"` });
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => findProviderDetails(item, `${path}/${pointerToken(index)}`, terms, issues));
    return;
  }
  if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      const childPath = `${path}/${pointerToken(key)}`;
      if (PROVIDER_KEYS.has(key)) {
        issues.push({
          code: "PROVIDER_KEY_FORBIDDEN",
          path: childPath,
          message: "recipe/provider detail is not allowed in command metadata",
        });
      }
      findProviderDetails(value, childPath, terms, issues);
    }
  }
}

function duplicates<T>(values: T[]): Set<T> {
  const seen = new Set<T>();
  const repeated = new Set<T>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return repeated;
}

/**
 * Validates the command catalogue on its own: schema plus every rule that needs no recipe or model
 * data. The provider scan runs on every document, schema-valid or not: forbidden keys at any depth,
 * and, when `providerTerms` are given (registry provider names, model IDs and bare model names), any
 * string outside evidence.refs that contains one as a whole word in any letter case. Cross-document
 * rules live in validate-contract.ts.
 */
export function validateCatalogue(
  catalogue: unknown,
  options: { providerTerms?: readonly string[] } = {},
): ContractIssue[] {
  const issues: ContractIssue[] = [];
  findProviderDetails(catalogue, "", providerTermPattern(options.providerTerms ?? []), issues);
  issues.push(...validateAgainstSchema(catalogueSchema, catalogue));
  if (issues.some((issue) => issue.code.startsWith("SCHEMA_"))) return issues;

  const { commands } = catalogue as CommandCatalogue;
  const at = (index: number, field = "") => `/commands/${index}${field}`;

  const duplicateIds = duplicates(commands.map((command) => command.id));
  const duplicateSlashes = duplicates(commands.map((command) => command.canonicalSlash));
  const canonical = new Set(commands.map((command) => command.canonicalSlash));
  const duplicateAliases = duplicates(commands.flatMap((command) => command.aliases.map((alias) => alias.slash)));

  commands.forEach((command, index) => {
    if (duplicateIds.has(command.id)) {
      issues.push({ code: "COMMAND_ID_DUPLICATE", path: at(index, "/id"), message: `duplicate id ${command.id}` });
    }
    if (duplicateSlashes.has(command.canonicalSlash)) {
      issues.push({
        code: "COMMAND_SLASH_DUPLICATE",
        path: at(index, "/canonicalSlash"),
        message: `duplicate canonical slash ${command.canonicalSlash}`,
      });
    }
    if (command.canonicalSlash !== `/${command.id}`) {
      issues.push({
        code: "COMMAND_SLASH_ID_MISMATCH",
        path: at(index, "/canonicalSlash"),
        message: `canonical slash must be /${command.id}`,
      });
    }

    command.aliases.forEach((alias, aliasIndex) => {
      const path = at(index, `/aliases/${aliasIndex}`);
      if (canonical.has(alias.slash)) {
        issues.push({ code: "ALIAS_COLLIDES_WITH_CANONICAL", path, message: `alias ${alias.slash} is a canonical slash` });
      }
      if (duplicateAliases.has(alias.slash)) {
        issues.push({ code: "ALIAS_DUPLICATE", path, message: `alias ${alias.slash} is used more than once` });
      }
      if (alias.kind === "brand_term" && alias.publicUse === "allowed") {
        issues.push({
          code: "BRAND_ALIAS_NOT_CLEARED",
          path,
          message: `brand alias ${alias.slash} stays review_required or blocked until a legal/product review changes this rule`,
        });
      }
    });

    if (command.recipeId === null && !EXECUTABLE_WITHOUT_RECIPE.has(command.maturity)) {
      issues.push({
        code: "COMMAND_RECIPE_REQUIRED",
        path: at(index, "/recipeId"),
        message: `maturity ${command.maturity} requires a recipe`,
      });
    }
    if (command.recipeId !== null && command.maturity === "candidate") {
      issues.push({
        code: "CANDIDATE_HAS_RECIPE",
        path: at(index, "/maturity"),
        message: "a candidate has no recipe; promote it to seed when a recipe is assigned",
      });
    }

    const { sourceImage, maxSourceImages, acceptedMimeTypes } = command.inputRequirements;
    const takesImage = sourceImage !== "none";
    if (takesImage !== maxSourceImages > 0) {
      issues.push({
        code: "SOURCE_IMAGE_COUNT_MISMATCH",
        path: at(index, "/inputRequirements/maxSourceImages"),
        message: `sourceImage ${sourceImage} with maxSourceImages ${maxSourceImages}`,
      });
    }
    if (takesImage !== acceptedMimeTypes.length > 0) {
      issues.push({
        code: "SOURCE_IMAGE_MIME_MISMATCH",
        path: at(index, "/inputRequirements/acceptedMimeTypes"),
        message: `sourceImage ${sourceImage} with ${acceptedMimeTypes.length} accepted MIME types`,
      });
    }

    for (const [flag, code] of requiredRiskFlags(command)) {
      if (!command.riskFlags.includes(flag)) {
        issues.push({ code, path: at(index, "/riskFlags"), message: `missing ${flag}` });
      }
    }

    const { status, refs } = command.evidence;
    if (status !== "unverified" && refs.length === 0) {
      issues.push({
        code: "EVIDENCE_REFS_REQUIRED",
        path: at(index, "/evidence/refs"),
        message: `evidence status ${status} needs at least one ref`,
      });
    }
    if ((command.provenance === "native" || command.provenance === "community") && status === "unverified") {
      issues.push({
        code: "PROVENANCE_EVIDENCE_REQUIRED",
        path: at(index, "/provenance"),
        message: `provenance ${command.provenance} needs sourced evidence`,
      });
    }
  });

  return issues;
}

export class CatalogueInvalidError extends Error {
  readonly issues: ContractIssue[];

  constructor(issues: ContractIssue[]) {
    super(`Command catalogue is invalid:\n${issues.map((i) => `${i.code} ${i.path}: ${i.message}`).join("\n")}`);
    this.name = "CatalogueInvalidError";
    this.issues = issues;
  }
}

/** Module-load check for UI code: catalogue rules and forbidden keys (no registry, so no term scan). */
export function assertValidCatalogue(catalogue: unknown): CommandCatalogue {
  const issues = validateCatalogue(catalogue);
  if (issues.length > 0) throw new CatalogueInvalidError(issues);
  return catalogue as CommandCatalogue;
}
