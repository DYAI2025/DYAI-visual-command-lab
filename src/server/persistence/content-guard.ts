import { pointerToken } from "../../domain/contract/json-schema.ts";
import { CatalogueStoreError } from "./errors.ts";

// What never belongs in Command/Recipe/Category persistence (DYAI-39 invariants 3 and 9): provider
// credentials, Model Capability runtime facts and image payloads. The contract schemas reject unknown
// keys too; this scan runs first and at any depth, so a smuggled value fails with one explicit code.
//
// Only decidable mechanisms, no guessing whether prose "looks like" a secret:
//  1. structure: credential-named keys and Model Capability keys are refused at any depth;
//  2. this server's own secrets: any text containing the value of a configured secret environment
//     variable (OPENROUTER_API_KEY and every *KEY / *SECRET / *TOKEN / *PASSWORD variable of 16+ chars);
//  3. fixed, prefix-anchored credential formats (CREDENTIAL_FORMATS) and `data:` URIs;
//  4. size: 4000 characters per text, per-document byte caps, unbroken tokens of at most 64 characters
//     (tokens containing "://": 512) and at most two 40+ character tokens per text. Separator runs
//     (tokens with fewer than 8 distinct characters, such as "-----") do not count as payload.
// Not detected: a credential of an unknown format that is shorter than 65 characters and is not this
// server's own secret (for example a generic bearer token or a password typed into prose). Encoded
// binary must be long unbroken tokens to be useful, so it hits the size rules; a payload cut into short
// pieces fits only under 4000 characters per text. Every check is a split or a single-pass regex without
// overlapping quantifiers, so it is linear in the input.

export const MAX_TEXT_LENGTH = 4000;
export const MAX_TOKEN_LENGTH = 64;
export const MAX_URL_TOKEN_LENGTH = 512;
const LONG_TOKEN = 40;
const MAX_LONG_TOKENS = 2;
const MIN_PAYLOAD_DISTINCT_CHARS = 8;
const MIN_SECRET_LENGTH = 16;
export const MAX_DOCUMENT_BYTES = { command: 32 * 1024, recipe: 64 * 1024, category: 8 * 1024 } as const;
export type GuardedKind = keyof typeof MAX_DOCUMENT_BYTES;

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

/** Prefix-anchored formats of well-known credentials. Prose does not start words with these prefixes. */
export const CREDENTIAL_FORMATS: readonly [string, RegExp][] = [
  ["OpenRouter key", /\bsk-or-v1-[A-Za-z0-9]{16}/i],
  ["OpenAI project / Anthropic key", /\bsk-(?:proj|ant)-[A-Za-z0-9_-]{16}/],
  ["Stripe secret / restricted key", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16}/],
  ["PEM private key", /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/],
  ["AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}/],
  ["Slack token", /\bxox[abposr]-[0-9]{6}/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30}|github_pat_[A-Za-z0-9_]{20})/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{8,64}\.eyJ[A-Za-z0-9_-]{8}/],
  ["URL with user:password", /\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s/:@]{1,64}:[^\s/@]{1,128}@/i],
];
const DATA_URI = /\bdata:[a-z0-9.+/-]{0,80}[;,]/i;
const SECRET_ENV_NAME = /(?:^OPENROUTER_API_KEY$|KEY$|SECRET$|TOKEN$|PASSWORD$)/;

/** Values of this server's secret environment variables (read at check time; never logged). */
function configuredSecrets(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === "string" && value.trim().length >= MIN_SECRET_LENGTH)
    .map(([, value]) => (value as string).trim());
}

const distinctChars = (token: string) => new Set(token).size;

function forbiddenText(text: string, secrets: readonly string[]): string | null {
  if (text.length > MAX_TEXT_LENGTH) return `text longer than ${MAX_TEXT_LENGTH} characters`;
  let longTokens = 0;
  for (const token of text.split(/\s+/)) {
    if (token.length < LONG_TOKEN) continue;
    if (distinctChars(token) < MIN_PAYLOAD_DISTINCT_CHARS) continue; // separator runs such as "-----"
    const url = token.includes("://");
    if (token.length > (url ? MAX_URL_TOKEN_LENGTH : MAX_TOKEN_LENGTH)) return "unbroken token too long (encoded payload?)";
    if (!url && ++longTokens > MAX_LONG_TOKENS) return `more than ${MAX_LONG_TOKENS} tokens of ${LONG_TOKEN}+ characters (encoded payload?)`;
  }
  if (DATA_URI.test(text)) return "data: URI";
  for (const [name, format] of CREDENTIAL_FORMATS) if (format.test(text)) return `credential (${name})`;
  if (secrets.some((secret) => text.includes(secret))) return "credential (a configured server secret)";
  return null;
}

/** Throws FORBIDDEN_CONTENT at the first credential, Model Capability fact, payload or oversize. */
export function assertNoForbiddenContent(document: unknown, kind: GuardedKind, env: Record<string, string | undefined> = process.env): void {
  const size = Buffer.byteLength(JSON.stringify(document) ?? "", "utf8");
  if (size > MAX_DOCUMENT_BYTES[kind]) {
    throw new CatalogueStoreError("FORBIDDEN_CONTENT", `${kind} is ${size} bytes, above ${MAX_DOCUMENT_BYTES[kind]}`);
  }
  const hit = findForbidden(document, "", configuredSecrets(env));
  if (hit) throw new CatalogueStoreError("FORBIDDEN_CONTENT", `${kind} ${hit}`);
}

function findForbidden(node: unknown, path: string, secrets: readonly string[]): string | null {
  if (typeof node === "string") {
    const reason = forbiddenText(node, secrets);
    return reason ? `${path || "/"}: ${reason}` : null;
  }
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) {
      const hit = findForbidden(item, `${path}/${index}`, secrets);
      if (hit) return hit;
    }
    return null;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      const childPath = `${path}/${pointerToken(key)}`;
      if (CREDENTIAL_KEY.test(key)) return `${childPath}: credential field`;
      if (MODEL_CAPABILITY_KEYS.has(key)) return `${childPath}: Model Capability field (the registry is separate)`;
      const keyReason = forbiddenText(key, secrets);
      if (keyReason) return `${childPath}: key ${keyReason}`;
      const hit = findForbidden(value, childPath, secrets);
      if (hit) return hit;
    }
  }
  return null;
}
