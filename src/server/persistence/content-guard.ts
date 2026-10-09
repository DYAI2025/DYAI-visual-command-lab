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
//  4. image bytes: after undoing JSON (\/) and URL (%2F, %2B, …) escaping, every run of 16+ base64 /
//     base64url (24+ hex) characters is decoded in every alignment and refused when an image file
//     signature of 4+ bytes (IMAGE_SIGNATURES) occurs at any byte position;
//  5. capacity: 4000 characters per text and a byte cap per document.
// Every check is a single-pass regex without overlapping quantifiers or a linear decode-and-scan of an
// encoded run (byte compares only), so the cost is linear in the input.

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
  ["URL with user:password", /\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s/:@?#]{1,64}:[^\s/@?#]{1,128}@/i],
];

// RFC 2397: data:[<mediatype>][;<parameter>]*,<data>. A media type is token "/" token; a parameter
// runs to the next ";" or ",". "{data:true,...}" in a code snippet has neither.
// RFC 2045 token (ASCII, as RFC 7230 tchar): no tspecials, no braces, no non-ASCII letters
const MEDIA_TOKEN = "[!#$%&'*+.^_`|~0-9a-z-]{1,80}";
// a pasted data: URI carries base64, percent-encoded or markup data right after the comma; prose such as
// "data:image/*, return a URL" or "data:image/png;base64,… in the response" does not
const DATA_URI = new RegExp(`\\bdata:(?:${MEDIA_TOKEN}/${MEDIA_TOKEN})?(?:;[^;,\\s]{1,200}){0,8},(?=[A-Za-z0-9+/=%<])`, "i");

const JPEG_MARKERS = new Set([0xdb, 0xc0, 0xc2, 0xc4, 0xfe, ...Array.from({ length: 16 }, (_, i) => 0xe0 + i)]);
// first bytes of the signatures below (PNG, JPEG, GIF, WebP, BMP, TIFF II/MM, ICO); HEIF/AVIF is
// recognised by "f" of "ftyp" at offset 4
const SIGNATURE_FIRST_BYTES = new Set([0x89, 0xff, 0x47, 0x52, 0x42, 0x49, 0x4d, 0x00]);
const codes = (text: string) => Array.from(text, (c) => c.charCodeAt(0));
/** b[i..] equals expected (plain byte compares: no allocation per position). */
const at = (b: Uint8Array, i: number, expected: readonly number[]) => expected.every((value, k) => b[i + k] === value);
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const RIFF = codes("RIFF");
const WEBP = codes("WEBP");
const FTYP = codes("ftyp");
const HEIF_BRANDS = ["heic", "heix", "hevc", "mif1", "msf1", "avif", "avis"].map(codes);

/** File signatures (4+ bytes each) of common raster image formats, checked at byte i of b. */
export const IMAGE_SIGNATURES: readonly [string, (b: Uint8Array, i: number) => boolean][] = [
  ["PNG", (b, i) => at(b, i, PNG)],
  ["JPEG", (b, i) => b[i] === 0xff && b[i + 1] === 0xd8 && b[i + 2] === 0xff && JPEG_MARKERS.has(b[i + 3])],
  ["GIF", (b, i) => at(b, i, [0x47, 0x49, 0x46, 0x38]) && (b[i + 4] === 0x37 || b[i + 4] === 0x39) && b[i + 5] === 0x61],
  ["WebP", (b, i) => at(b, i, RIFF) && at(b, i + 8, WEBP)],
  ["BMP", (b, i) => b[i] === 0x42 && b[i + 1] === 0x4d && at(b, i + 6, [0, 0, 0, 0])],
  ["TIFF", (b, i) => at(b, i, [0x49, 0x49, 42, 0]) || at(b, i, [0x4d, 0x4d, 0, 42])],
  ["ICO", (b, i) => at(b, i, [0, 0, 1, 0]) && b[i + 4] > 0 && b[i + 5] === 0],
  ["HEIF/AVIF", (b, i) => at(b, i + 4, FTYP) && HEIF_BRANDS.some((brand) => at(b, i + 8, brand))],
];
const BASE64_RUN = /[A-Za-z0-9+/_-]{16,}/g;
const HEX_RUN = /[0-9a-fA-F]{24,}/g;

/** Undo the JSON and URL escapes that would split an encoded run (linear, fixed replacements). */
function unescapeRuns(text: string): string {
  return text.replace(/\\\//g, "/").replace(/%(2F|2B|3D|3A|3B|2C)/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** The image format whose signature occurs anywhere in the decoded bytes of an encoded run, if any. */
function imageInRun(run: string, encoding: "base64" | "hex"): string | null {
  // decoding starts at each alignment of the first unit, so a signature after any prefix is found
  const unit = encoding === "base64" ? 4 : 2;
  const normalized = encoding === "base64" ? run.replace(/-/g, "+").replace(/_/g, "/") : run;
  for (let offset = 0; offset < unit; offset++) {
    const usable = Math.floor((normalized.length - offset) / unit) * unit;
    if (usable < unit * 3) continue;
    const bytes = Buffer.from(normalized.slice(offset, offset + usable), encoding);
    for (let i = 0; i + 4 <= bytes.length; i++) {
      if (!SIGNATURE_FIRST_BYTES.has(bytes[i]) && bytes[i + 4] !== 0x66) continue;
      const hit = IMAGE_SIGNATURES.find(([, matches]) => matches(bytes, i));
      if (hit) return hit[0];
    }
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

function forbiddenText(raw: string, secrets: readonly string[]): string | null {
  if (raw.length > MAX_TEXT_LENGTH) return `text longer than ${MAX_TEXT_LENGTH} characters`;
  // credential formats see the text as written (unescaping them refused redirect and safelink URLs);
  // data: URIs, images and configured secrets are also checked with JSON/URL escaping undone
  const text = unescapeRuns(raw);
  if (DATA_URI.test(raw) || DATA_URI.test(text)) return "data: URI";
  for (const [name, format] of CREDENTIAL_FORMATS) if (format.test(raw)) return `credential (${name})`;
  if (secrets.some((secret) => raw.includes(secret) || text.includes(secret))) return "credential (a configured server secret)";
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
