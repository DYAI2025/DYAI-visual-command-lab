import { pointerToken } from "../../domain/contract/json-schema.ts";
import { CatalogueStoreError } from "./errors.ts";

// What never belongs in Command/Recipe/Category persistence (DYAI-39 invariants 3 and 9): credentials,
// Model Capability runtime facts and image payloads. The contract schemas reject unknown keys too;
// this scan runs first and at any depth, so a smuggled value fails with one explicit code.
//
// Mechanisms (what this guard measures, and nothing more):
//  1. structure: credential-named keys and Model Capability keys are refused at any depth;
//  2. size: a text longer than MAX_TEXT_LENGTH, a whitespace-free token longer than MAX_TOKEN_LENGTH
//     (http(s) URLs up to MAX_URL_LENGTH), or more than MAX_LONG_TOKENS tokens of LONG_TOKEN or more
//     characters is refused, and so is a whole document above its byte cap. Authoring copy is prose and
//     slugs (the VC-01 seed's longest token is 24 characters); encoded binary is long tokens. A payload
//     cut into short whitespace-separated pieces still fits under these caps, but only in small amounts
//     (under MAX_TEXT_LENGTH characters per text);
//  3. shapes: `data:` URIs and a fixed list of well-known credential formats (CREDENTIAL_SHAPES).
// Every check is linear in the input: plain splits and single-pass regexes without nested or
// overlapping quantifiers, so an adversarial 4000-character value cannot stall the server.

export const MAX_TEXT_LENGTH = 4000;
export const MAX_TOKEN_LENGTH = 64;
export const MAX_URL_LENGTH = 512;
const LONG_TOKEN = 40;
const MAX_LONG_TOKENS = 2;
export const MAX_DOCUMENT_BYTES = { command: 32 * 1024, recipe: 64 * 1024, category: 8 * 1024, seed: 2 * 1024 * 1024 } as const;

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

/** Well-known credential formats. Not exhaustive by nature: an unknown format is bounded only by the size rules. */
export const CREDENTIAL_SHAPES: readonly [string, RegExp][] = [
  ["OpenRouter key", /\bsk-or-v1-[A-Za-z0-9]{16}/i],
  ["OpenAI/Anthropic-style key", /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20}/],
  ["PEM private key", /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/],
  ["AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}/],
  ["Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10}/i],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30}|github_pat_[A-Za-z0-9_]{20})/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{8,64}\.eyJ[A-Za-z0-9_-]{8}/],
  ["URL with user:password", /\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s/:@]{1,64}:[^\s/@]{1,128}@/i],
];
const DATA_URI = /\bdata:[a-z0-9.+/-]{0,80}[;,]/i;
const AUTH_HEADER = /\b(?:bearer|basic|digest)\s+(\S{16,})/gi;
const URL_TOKEN = /^(?:https?:\/\/|\/)/i;

/** An auth-scheme value that looks like a credential: long, and not a plain lower-case word. */
function looksLikeAuthValue(value: string): boolean {
  return /[0-9]/.test(value) || /[._~+/=-]/.test(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value));
}

function forbiddenText(text: string): string | null {
  if (text.length > MAX_TEXT_LENGTH) return `text longer than ${MAX_TEXT_LENGTH} characters`;
  let longTokens = 0;
  for (const token of text.split(/\s+/)) {
    const limit = URL_TOKEN.test(token) ? MAX_URL_LENGTH : MAX_TOKEN_LENGTH;
    if (token.length > limit) return `unbroken token longer than ${limit} characters (encoded payload?)`;
    if (token.length >= LONG_TOKEN && !URL_TOKEN.test(token) && ++longTokens > MAX_LONG_TOKENS) {
      return `more than ${MAX_LONG_TOKENS} tokens of ${LONG_TOKEN}+ characters (encoded payload?)`;
    }
  }
  if (DATA_URI.test(text)) return "data: URI";
  for (const [name, shape] of CREDENTIAL_SHAPES) if (shape.test(text)) return `credential-like value (${name})`;
  for (const match of text.matchAll(AUTH_HEADER)) if (looksLikeAuthValue(match[1])) return "credential-like value (auth header)";
  return null;
}

/** Throws FORBIDDEN_CONTENT at the first credential, Model Capability fact, payload or oversize. */
export function assertNoForbiddenContent(document: unknown, label: keyof typeof MAX_DOCUMENT_BYTES | `seed ${string}`): void {
  const kind = label.startsWith("seed") ? "seed" : (label as keyof typeof MAX_DOCUMENT_BYTES);
  const size = Buffer.byteLength(JSON.stringify(document) ?? "", "utf8");
  if (size > MAX_DOCUMENT_BYTES[kind]) {
    throw new CatalogueStoreError("FORBIDDEN_CONTENT", `${label} is ${size} bytes, above ${MAX_DOCUMENT_BYTES[kind]}`);
  }
  const hit = findForbidden(document, "");
  if (hit) throw new CatalogueStoreError("FORBIDDEN_CONTENT", `${label} ${hit}`);
}

function findForbidden(node: unknown, path: string): string | null {
  if (typeof node === "string") {
    const reason = forbiddenText(node);
    return reason ? `${path || "/"}: ${reason}` : null;
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
      const keyReason = forbiddenText(key);
      if (keyReason) return `${childPath}: key ${keyReason}`;
      const hit = findForbidden(value, childPath);
      if (hit) return hit;
    }
  }
  return null;
}
