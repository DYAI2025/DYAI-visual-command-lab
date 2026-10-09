import { pointerToken } from "../../domain/contract/json-schema.ts";
import { CatalogueStoreError } from "./errors.ts";

// What never belongs in Command/Recipe/Category persistence (DYAI-39 invariants 3 and 9): provider
// credentials, Model Capability runtime facts and image payloads. The contract schemas reject unknown
// keys too; this scan runs first and at any depth, so a smuggled value fails with one explicit code.
//
// Threat model: an operator or an AI-generated candidate (DYAI-40) ACCIDENTALLY carries a pasted data:
// URI, an encoded image, a well-known credential or one of this server's own secrets into authoring
// data. Out of scope: an authenticated operator who deliberately disguises bytes or an unknown secret
// (that operator could equally change code); for that, the size caps bound how much can be stored.
//
// Only decidable mechanisms, no guessing whether a word "looks like" a secret or a payload:
//  1. structure: credential-named keys and Model Capability keys are refused at any depth;
//  2. this server's own secrets: any text containing the value of a configured secret environment
//     variable (OPENROUTER_API_KEY and every *KEY / *SECRET / *TOKEN / *PASSWORD variable of 16+ chars);
//  3. fixed formats: RFC 2397 data: URIs and prefix-anchored credential formats (CREDENTIAL_FORMATS);
//  4. image bytes: every run of 16+ base64/base64url (24+ hex) characters is decoded at its start and
//     refused when the bytes begin with an image file signature (IMAGE_SIGNATURES);
//  5. capacity: 4000 characters per text and a byte cap per document.
// Every check is a single-pass regex without overlapping quantifiers or a fixed-size decode, so it is
// linear in the input.

export const MAX_TEXT_LENGTH = 4000;
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

// RFC 2397: data:[<mediatype>][;<parameter>]*,<data>. A media type is token "/" token; a parameter
// runs to the next ";" or ",". "{data:true,...}" in a code snippet has neither.
const MEDIA_TOKEN = "[a-z0-9!#$&^_.+-]{1,80}";
const DATA_URI = new RegExp(`\\bdata:(?:${MEDIA_TOKEN}/${MEDIA_TOKEN})?(?:;[^;,\\s]{1,200}){0,8},`, "i");

function ascii(bytes: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...bytes.subarray(from, to));
}

/** File signatures of common raster image formats. */
export const IMAGE_SIGNATURES: readonly [string, (b: Uint8Array) => boolean][] = [
  ["PNG", (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  ["JPEG", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["GIF", (b) => ascii(b, 0, 4) === "GIF8"],
  ["WebP", (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP"],
  ["BMP", (b) => ascii(b, 0, 2) === "BM" && b[6] === 0 && b[7] === 0 && b[8] === 0 && b[9] === 0],
  ["TIFF", (b) => (ascii(b, 0, 2) === "II" && b[2] === 42 && b[3] === 0) || (ascii(b, 0, 2) === "MM" && b[2] === 0 && b[3] === 42)],
  ["ICO", (b) => b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 && b[4] > 0],
  ["HEIF/AVIF", (b) => ascii(b, 4, 8) === "ftyp" && /^(?:heic|heix|hevc|mif1|msf1|avif|avis)$/.test(ascii(b, 8, 12))],
];
const BASE64_RUN = /[A-Za-z0-9+/_-]{16,}/g;
const HEX_RUN = /[0-9a-fA-F]{24,}/g;

/** The image format whose signature the first decoded bytes of an encoded run carry, if any. */
function imageInRun(run: string, encoding: "base64" | "hex"): string | null {
  // the run may be glued to preceding characters of the same alphabet (e.g. "x://iVBOR…" yields the
  // run "//iVBOR…"), so try every alignment within the first encoding unit
  const alignments = encoding === "base64" ? 4 : 2;
  const width = encoding === "base64" ? 16 : 24;
  for (let offset = 0; offset < alignments && offset + width <= run.length; offset++) {
    let head = run.slice(offset, offset + width);
    if (encoding === "base64") head = head.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Buffer.from(head, encoding);
    const hit = IMAGE_SIGNATURES.find(([, matches]) => matches(bytes));
    if (hit) return hit[0];
  }
  return null;
}

const SECRET_ENV_NAME = /(?:^OPENROUTER_API_KEY$|KEY$|SECRET$|TOKEN$|PASSWORD$)/;

/** Values of this server's secret environment variables (read at check time; never logged). */
function configuredSecrets(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === "string" && value.trim().length >= MIN_SECRET_LENGTH)
    .map(([, value]) => (value as string).trim());
}

function forbiddenText(text: string, secrets: readonly string[]): string | null {
  if (text.length > MAX_TEXT_LENGTH) return `text longer than ${MAX_TEXT_LENGTH} characters`;
  if (DATA_URI.test(text)) return "data: URI";
  for (const [name, format] of CREDENTIAL_FORMATS) if (format.test(text)) return `credential (${name})`;
  if (secrets.some((secret) => text.includes(secret))) return "credential (a configured server secret)";
  for (const [run] of text.matchAll(BASE64_RUN)) {
    const image = imageInRun(run, "base64");
    if (image) return `encoded ${image} image`;
  }
  for (const [run] of text.matchAll(HEX_RUN)) {
    const image = imageInRun(run, "hex");
    if (image) return `hex-encoded ${image} image`;
  }
  return null;
}

/** Throws FORBIDDEN_CONTENT at the first credential, Model Capability fact, image payload or oversize. */
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
      // the offending key is not echoed: it may itself be the secret, and messages reach logs
      const keyReason = forbiddenText(key, secrets);
      if (keyReason) return `${path || "/"}: a key (${keyReason})`;
      const hit = findForbidden(value, childPath, secrets);
      if (hit) return hit;
    }
  }
  return null;
}
