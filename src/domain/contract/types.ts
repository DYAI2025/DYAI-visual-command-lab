import type { IssueCode } from "./issue-codes.ts";

// TypeScript view of the v1.0.0 contract schemas in ./schemas. The JSON Schemas plus the
// validators are the enforced source of truth; these types describe data that passed them.

export type Slash = `/${string}`;
export type Lane = "play" | "explain" | "polish";
export type Maturity = "candidate" | "seed" | "curated" | "validated" | "deprecated";
export type TruthMode = "creative_entertainment" | "truth_preserving_edit" | "evidence_grounded_workflow";
export type InputNeed = "required" | "optional" | "none";

export interface LocalizedText {
  en: string;
  de: string;
}

export interface LocalizedDisplay {
  name: string;
  description: string;
}

export interface CommandAlias {
  slash: Slash;
  kind: "spelling_variant" | "translation" | "brand_term";
  publicUse: "allowed" | "review_required" | "blocked";
}

export interface CommandThumbnail {
  fixtureFamily: "person" | "object" | "space" | "scene" | "document";
  src: string;
  alt: LocalizedText;
}

export type RiskFlag =
  | "synthetic_visualisation"
  | "invented_content_risk"
  | "identity_preservation"
  | "brand_reference"
  | "person_likeness";

export interface CommandRecord {
  id: string;
  canonicalSlash: Slash;
  aliases: CommandAlias[];
  lane: Lane;
  display: { en: LocalizedDisplay; de: LocalizedDisplay };
  semanticClass: "visual_transform" | "enriched_recipe" | "professional_workflow";
  tags: string[];
  job: LocalizedText;
  recipeId: string | null;
  inputRequirements: {
    sourceImage: InputNeed;
    maxSourceImages: number;
    acceptedMimeTypes: ("image/jpeg" | "image/png" | "image/webp")[];
    textInstruction: InputNeed;
  };
  thumbnails: CommandThumbnail[];
  riskFlags: RiskFlag[];
  maturity: Maturity;
  evidence: {
    observation: "observed" | "proposed";
    status: "unverified" | "source_linked" | "fixture_tested";
    refs: string[];
  };
  provenance: "native" | "community" | "custom" | "semantic_alias" | "unknown";
}

export interface CommandCatalogue {
  schemaVersion: "1.0.0";
  commands: CommandRecord[];
}

export type PreservedCharacteristic =
  | "subject_identity"
  | "people"
  | "object_identity"
  | "geometry"
  | "logos_text"
  | "visible_defects"
  | "material_characteristics"
  | "composition"
  | "pose"
  | "expression"
  | "source_topic";

export type AdjustableCharacteristic =
  | "exposure"
  | "tonal_treatment"
  | "colour_treatment"
  | "perceived_lighting"
  | "contrast"
  | "sharpness_treatment"
  | "film_character"
  | "atmosphere_depth"
  | "rendering_style"
  | "material_rendering"
  | "scale_presentation"
  | "background"
  | "layout"
  | "text_labels";

export interface RecipeParameter {
  name: string;
  type: "enum" | "string" | "number" | "boolean";
  required: boolean;
  options?: string[];
  default?: string | number | boolean;
  description: string;
}

export interface Recipe {
  recipeId: string;
  version: string;
  baseIntent: string;
  truthMode: TruthMode;
  inputs: { referenceImage: InputNeed };
  preserve: PreservedCharacteristic[];
  mayChange: AdjustableCharacteristic[];
  mutableRegions: string[];
  immutableFeatures: string[];
  constraints: string[];
  negativeConstraints: string[];
  parameters: RecipeParameter[];
  modelAdapters: { modelRef: string; status: "untested" | "approved" | "rejected"; promptOverrides: string[] }[];
  expectedFailureModes: { id: string; description: string }[];
  confirmationGates: {
    id: string;
    when: "before_generation" | "before_download" | "before_publication";
    description: string;
  }[];
  testedModels: { modelRef: string; testedAt: string; result: "pass" | "partial" | "fail"; fixtureRefs: string[] }[];
  lastTestedAt: string | null;
  fixtureRefs: string[];
  evaluationStatus: "untested" | "fixture_tested" | "benchmarked" | "rejected";
}

export interface RecipeBook {
  schemaVersion: "1.0.0";
  recipes: Recipe[];
}

interface Measurement {
  status: "unknown" | "provider_listed" | "measured";
  source: string | null;
  observedAt: string | null;
}

export interface CostMeasurement extends Measurement {
  inputUsdPerMillionTokens?: number;
  textOutputUsdPerMillionTokens?: number;
  imageOutputUsdPerMillionTokens?: number;
}

export interface LatencyMeasurement extends Measurement {
  p50Ms?: number;
  p95Ms?: number;
}

export interface ModelCapability {
  id: string;
  provider: "openrouter";
  providerModelId: string;
  capabilities: {
    inputModalities: ("text" | "image" | "file" | "audio" | "video")[];
    outputModalities: ("text" | "image")[];
    referenceImage: boolean;
    maxReferenceImages: number;
    aspectRatios?: string[];
  };
  allowlist: "allowed" | "candidate" | "blocked";
  benchmarkStatus: "unbenchmarked" | "in_progress" | "passed" | "failed";
  cost: CostMeasurement;
  latency: LatencyMeasurement;
  policy: {
    privacyReview: "unreviewed" | "approved" | "rejected";
    dataRetention: "unknown" | "none" | "provider_limited" | "provider_retained";
  };
  lifecycle: "active" | "disabled" | "deprecated";
  evidenceRefs: string[];
}

export interface ModelRegistry {
  schemaVersion: "1.0.0";
  models: ModelCapability[];
}

export interface ContractBundle {
  catalogue: unknown;
  recipes: unknown;
  models: unknown;
}

export interface ContractIssue {
  code: IssueCode;
  path: string;
  message: string;
}
