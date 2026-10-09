// Bounded parsing of a POST /api/generate body: multipart/form-data with exactly the fields
// `command` (slash or id), `image` (the source file) and optional `parameters` (a JSON object of
// recipe parameter values). The body is read with a hard byte cap before any parsing.

export class GenerationRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "GenerationRequestError";
    this.status = status;
    this.code = code;
  }
}

export interface UploadedImage {
  bytes: Uint8Array;
  declaredType: string;
}

export interface GenerationRequest {
  commandRef: string;
  images: UploadedImage[];
  parameters: Record<string, string>;
}

const FIELDS = new Set(["command", "image", "parameters"]);
/** Room for multipart boundaries, headers and the small text fields around the image. */
const ENVELOPE_BYTES = 64 * 1024;
const MAX_PARAMETERS = 16;
const MAX_PARAMETERS_JSON = 4096;

async function readBounded(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    throw new GenerationRequestError(413, "request_too_large");
  }
  if (!request.body) throw new GenerationRequestError(400, "invalid_request");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      // Stop reading; the rest of the body is never buffered. (Cancelling races undici's producer.)
      reader.releaseLock();
      throw new GenerationRequestError(413, "request_too_large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function parseParameters(raw: FormDataEntryValue[]): Record<string, string> {
  if (raw.length === 0) return {};
  const [value] = raw;
  if (raw.length > 1 || typeof value !== "string" || value.length > MAX_PARAMETERS_JSON) {
    throw new GenerationRequestError(400, "invalid_parameters");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new GenerationRequestError(400, "invalid_parameters");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GenerationRequestError(400, "invalid_parameters");
  }
  const entries = Object.entries(parsed);
  if (entries.length > MAX_PARAMETERS || entries.some(([, v]) => typeof v !== "string")) {
    throw new GenerationRequestError(400, "invalid_parameters");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

export async function readGenerationRequest(request: Request, maxUploadBytes: number): Promise<GenerationRequest> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data;/i.test(contentType)) throw new GenerationRequestError(415, "unsupported_content_type");

  const body = await readBounded(request, maxUploadBytes + ENVELOPE_BYTES);
  let form: FormData;
  try {
    form = await new Response(body as BodyInit, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new GenerationRequestError(400, "invalid_request");
  }

  for (const key of form.keys()) {
    if (!FIELDS.has(key)) throw new GenerationRequestError(400, "unexpected_field");
  }

  const command = form.getAll("command");
  if (command.length !== 1 || typeof command[0] !== "string" || command[0].length < 1 || command[0].length > 64) {
    throw new GenerationRequestError(400, "invalid_command");
  }

  const images: UploadedImage[] = [];
  for (const entry of form.getAll("image")) {
    if (typeof entry === "string") throw new GenerationRequestError(400, "image_required");
    if (entry.size === 0) throw new GenerationRequestError(400, "image_empty");
    if (entry.size > maxUploadBytes) throw new GenerationRequestError(413, "image_too_large");
    images.push({ bytes: new Uint8Array(await entry.arrayBuffer()), declaredType: entry.type });
  }

  return { commandRef: command[0], images, parameters: parseParameters(form.getAll("parameters")) };
}
