import { createHash } from "node:crypto";
import { inspectImage, type ImageMimeType } from "../generation/image.ts";
import type { SpendOutcome } from "../budget/port.ts";

// OpenRouter Image API adapter: POST {baseUrl}/images (docs, read 2026-10-06:
// openrouter.ai/docs/guides/overview/multimodal/image-generation). Request
// {model, prompt, input_references: [{type: "image_url", image_url: {url}}], n, resolution, provider,
// user}; response {created, data: [{b64_json, media_type?}], usage: {cost?}}. Billing is
// all-or-nothing: a generation that does not complete is not billed.
//
// Nothing from the provider response body except the generated image and the numeric cost leaves
// this module. Errors carry a classified kind and the HTTP status, never the provider message.

export interface ExecutionProfile {
  /** OpenRouter provider slugs (per-endpoint `provider_tag`) this model may run on. */
  only: readonly string[];
  resolution?: "512" | "1K" | "2K" | "4K";
}

/**
 * Provider routing per executable model. A model without a profile is not executed: routing pins
 * belong to the privacy review of that model (docs/generation-boundary.md).
 */
export const EXECUTION_PROFILES: Readonly<Record<string, ExecutionProfile>> = {
  // Only the Vertex endpoint of this model is on OpenRouter's zero-data-retention list (2026-10-06).
  "google/gemini-3.1-flash-image": { only: ["google-vertex/global"], resolution: "1K" },
};

export type ProviderErrorKind =
  | "timeout"
  | "unreachable"
  | "rate_limited"
  | "unavailable"
  | "rejected_request"
  | "rejected_image"
  | "content_refused"
  | "failed"
  | "invalid_response"
  | "no_image";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly providerStatus: number | null;
  readonly charge: SpendOutcome;
  readonly retryAfterSeconds: number | null;

  constructor(kind: ProviderErrorKind, providerStatus: number | null, charge: SpendOutcome, retryAfterSeconds: number | null = null) {
    super(`Image provider error: ${kind}${providerStatus === null ? "" : ` (HTTP ${providerStatus})`}`);
    this.name = "ProviderError";
    this.kind = kind;
    this.providerStatus = providerStatus;
    this.charge = charge;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface ImageGenerationInput {
  providerModelId: string;
  profile: ExecutionProfile;
  prompt: string;
  sourceImage: { mimeType: ImageMimeType; bytes: Uint8Array };
  /** Hashed before it is sent; OpenRouter hashes it again and never forwards it raw. */
  principalId: string;
}

export interface GeneratedImage {
  mimeType: ImageMimeType;
  width: number;
  height: number;
  bytes: Uint8Array;
}

export interface ImageGenerationResult {
  image: GeneratedImage;
  /** Provider-reported cost in USD, or null when the response did not carry one. */
  costUsd: number | null;
  providerStatus: number;
}

export interface ImageProvider {
  generate(input: ImageGenerationInput): Promise<ImageGenerationResult>;
}

export interface OpenRouterClientOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  maxOutputBytes: number;
  appUrl?: string;
  fetch?: typeof fetch;
}

const NOT_CHARGED: SpendOutcome = { kind: "not_charged" };
const UNKNOWN: SpendOutcome = { kind: "unknown" };
const IMAGE_ERROR_TYPES = new Set(["invalid_image", "image_too_large", "image_too_small", "unsupported_image_format"]);
const POLICY_ERROR_TYPES = new Set(["content_policy_violation", "refusal"]);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function retryAfter(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  return Math.min(Math.max(Number(raw.trim()), 1), 3600);
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function parseJson(bytes: Uint8Array | null): unknown {
  if (bytes === null) return undefined;
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return undefined;
  }
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function errorType(body: unknown): string | null {
  const metadata = record(record(record(body)?.error)?.metadata);
  return typeof metadata?.error_type === "string" ? metadata.error_type : null;
}

function classifyHttpError(status: number, body: unknown, response: Response): ProviderError {
  const type = errorType(body);
  if (status === 429) return new ProviderError("rate_limited", status, NOT_CHARGED, retryAfter(response));
  if (status === 408 || status === 524) return new ProviderError("timeout", status, NOT_CHARGED);
  if (status === 401 || status === 402 || status === 503) {
    return new ProviderError("unavailable", status, NOT_CHARGED, retryAfter(response));
  }
  if (status === 403) {
    return new ProviderError(type && POLICY_ERROR_TYPES.has(type) ? "content_refused" : "unavailable", status, NOT_CHARGED);
  }
  if (status >= 400 && status < 500) {
    return new ProviderError(type && IMAGE_ERROR_TYPES.has(type) ? "rejected_image" : "rejected_request", status, NOT_CHARGED);
  }
  return new ProviderError("failed", status, NOT_CHARGED);
}

function decodeImage(body: unknown, maxOutputBytes: number, status: number): GeneratedImage {
  const data = record(body)?.data;
  const first = Array.isArray(data) ? record(data[0]) : null;
  if (!first) throw new ProviderError("no_image", status, UNKNOWN);
  const b64 = first.b64_json;
  if (typeof b64 !== "string" || b64.length === 0 || b64.length % 4 !== 0 || !BASE64.test(b64)) {
    throw new ProviderError("invalid_response", status, UNKNOWN);
  }
  if ((b64.length / 4) * 3 > maxOutputBytes + 2) throw new ProviderError("invalid_response", status, UNKNOWN);
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  const info = inspectImage(bytes);
  if (!info) throw new ProviderError("invalid_response", status, UNKNOWN);
  return { ...info, bytes };
}

function cost(body: unknown): number | null {
  const value = record(record(body)?.usage)?.cost;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function createOpenRouterClient(options: OpenRouterClientOptions): ImageProvider {
  const send = options.fetch ?? fetch;
  // Base64 inflates by 4/3; leave room for the JSON envelope and usage block.
  const maxResponseBytes = Math.ceil((options.maxOutputBytes * 4) / 3) + 64 * 1024;

  return {
    async generate(input) {
      if (input.profile.only.length === 0) throw new ProviderError("rejected_request", null, NOT_CHARGED);
      const url = `data:${input.sourceImage.mimeType};base64,${Buffer.from(input.sourceImage.bytes).toString("base64")}`;
      const body = {
        model: input.providerModelId,
        prompt: input.prompt,
        input_references: [{ type: "image_url", image_url: { url } }],
        n: 1,
        ...(input.profile.resolution ? { resolution: input.profile.resolution } : {}),
        provider: { only: [...input.profile.only], allow_fallbacks: false },
        user: `dyai-${createHash("sha256").update(input.principalId).digest("hex").slice(0, 32)}`,
      };
      const headers: Record<string, string> = {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        "X-OpenRouter-Title": "DYAI Visual Command Lab",
      };
      if (options.appUrl) headers["HTTP-Referer"] = options.appUrl;

      let response: Response;
      try {
        response = await send(`${options.baseUrl}/images`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(options.timeoutMs),
          cache: "no-store",
          redirect: "error",
        });
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        // An aborted generation may still complete upstream: keep the reservation as the charge.
        throw new ProviderError(timedOut ? "timeout" : "unreachable", null, UNKNOWN);
      }

      let raw: Uint8Array | null;
      try {
        raw = await readCapped(response, maxResponseBytes);
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        throw new ProviderError(timedOut ? "timeout" : "invalid_response", response.status, UNKNOWN);
      }
      const parsed = parseJson(raw);

      if (!response.ok) throw classifyHttpError(response.status, parsed, response);
      if (parsed === undefined) throw new ProviderError("invalid_response", response.status, UNKNOWN);
      // Defensive: some OpenRouter routes report upstream failure as 200 with only an error body.
      if (record(parsed)?.error !== undefined && record(parsed)?.data === undefined) {
        throw new ProviderError("failed", response.status, NOT_CHARGED);
      }
      return { image: decodeImage(parsed, options.maxOutputBytes, response.status), costUsd: cost(parsed), providerStatus: response.status };
    },
  };
}
