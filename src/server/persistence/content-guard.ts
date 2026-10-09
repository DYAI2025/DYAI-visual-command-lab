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

const CREDENTIAL_VALUE = [
  /\bsk-or-v1-[A-Za-z0-9]{8,}/,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
];
const IMAGE_PAYLOAD = [/data:[a-z]+\/[a-z0-9.+-]+;base64,/i, /[A-Za-z0-9+/]{256,}={0,2}/];

/** Throws FORBIDDEN_CONTENT at the first credential, Model Capability fact or image payload. */
export function assertNoForbiddenContent(document: unknown, label: string): void {
  const hit = findForbidden(document, "");
  if (hit) throw new CatalogueStoreError("FORBIDDEN_CONTENT", `${label} ${hit}`);
}

function findForbidden(node: unknown, path: string): string | null {
  if (typeof node === "string") {
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
