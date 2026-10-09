import { pointerToken } from "../../domain/contract/json-schema.ts";
import { CatalogueStoreError } from "./errors.ts";

// What never belongs in Command/Recipe/Category persistence (DYAI-39 invariants 3 and 9): credentials,
// Model Capability runtime facts and image payloads. The contract schemas reject unknown keys too;
// this scan runs first and at any depth, so a smuggled value fails with one explicit code.

const CREDENTIAL_KEY = /^(?:api[-_]?keys?|secrets?|tokens?|access[-_]?tokens?|refresh[-_]?tokens?|passwords?|passwd|authorization|credentials?|private[-_]?keys?|access[-_]?keys?|bearer|cookies?)$/i;

// Keys that only a Model Capability (registry) document carries. Recipes reference models by
// modelRef; they never hold the capability itself.
const MODEL_CAPABILITY_KEYS = new Set([
  "providerModelId",
  "allowlist",
  "benchmarkStatus",
  "inputModalities",
  "outputModalities",
  "maxReferenceImages",
  "privacyReview",
  "dataRetention",
  "inputUsdPerMillionTokens",
  "imageOutputUsdPerMillionTokens",
  "textOutputUsdPerMillionTokens",
]);

// Credential shapes (case-insensitive where the scheme is). Not exhaustive by nature; the closed
// contract schemas and the length cap below bound what a missed shape could carry.
const CREDENTIAL_VALUE = [
  /\bsk-or-v1-[A-Za-z0-9]{8,}/i,
  /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{20,}/i,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  // an auth scheme followed by a token-like value (one with a digit: prose like "basic understanding" passes)
  /\b(?:bearer|basic|digest)\s+(?=[A-Za-z._~+/=-]*[0-9])[A-Za-z0-9._~+/=-]{12,}/i,
  /\b(?:api[-_ ]?key|secret|password|passwd|token)\s*[:=]\s*\S{8,}/i,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i, // URL with user:password
];
// Image or binary payloads: any data: URI with a media type, long base64/base64url runs, and
// line-wrapped base64 blocks.
const IMAGE_PAYLOAD = [
  /data:[a-z]+\/[a-z0-9.+-]+[;,]/i,
  /[A-Za-z0-9+/_-]{200,}={0,2}/,
  /(?:[A-Za-z0-9+/_-]{40,}={0,2}\s*\n\s*){3,}/,
];
/** No single persisted text needs to be longer; anything longer is refused rather than stored. */
export const MAX_TEXT_LENGTH = 4000;

/** Throws FORBIDDEN_CONTENT at the first credential, Model Capability fact or image payload. */
export function assertNoForbiddenContent(document: unknown, label: string): void {
  const hit = findForbidden(document, "");
  if (hit) throw new CatalogueStoreError("FORBIDDEN_CONTENT", `${label} ${hit}`);
}

function findForbidden(node: unknown, path: string): string | null {
  if (typeof node === "string") {
    if (node.length > MAX_TEXT_LENGTH) return `${path || "/"}: value longer than ${MAX_TEXT_LENGTH} characters`;
    if (CREDENTIAL_VALUE.some((pattern) => pattern.test(node))) return `${path || "/"}: credential-like value`;
    if (IMAGE_PAYLOAD.some((pattern) => pattern.test(node))) return `${path || "/"}: image or binary payload`;
    return null;
  }
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) {
      const hit = findForbidden(item, `${path}/${index}`);
      if (hit) return hit;
    }
    return null;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      const childPath = `${path}/${pointerToken(key)}`;
      if (CREDENTIAL_KEY.test(key)) return `${childPath}: credential field`;
      if (MODEL_CAPABILITY_KEYS.has(key)) return `${childPath}: Model Capability field (the registry is separate)`;
      const hit = findForbidden(value, childPath);
      if (hit) return hit;
    }
  }
  return null;
}
