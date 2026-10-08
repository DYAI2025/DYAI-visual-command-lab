// Technical generation telemetry for DYAI-37 (not the DYAI-19 analytics product). An event carries
// only the allowlisted fields below: no principal id, no image bytes or base64, no prompt text, no
// provider response body, no credentials. buildGenerationEvent copies field by field, so extra
// properties on its input never reach the sink.

export type GenerationOutcome = "succeeded" | "rejected" | "failed";

export interface GenerationEvent {
  event: "generation";
  requestId: string;
  outcome: GenerationOutcome;
  /** "ok" on success, otherwise the error code returned to the caller. */
  reason: string;
  httpStatus: number;
  commandId: string | null;
  lane: string | null;
  recipeId: string | null;
  recipeVersion: string | null;
  modelId: string | null;
  latencyMs: number;
  providerLatencyMs: number | null;
  providerStatus: number | null;
  costUsd: number | null;
  costSource: "provider_usage" | "unavailable" | "not_applicable";
  /** Error class name of an unexpected failure (500), so causes can be told apart; never a message. */
  errorName: string | null;
}

export type TelemetrySink = (event: GenerationEvent) => void;

const SAFE = /^[A-Za-z0-9._:/@-]{1,128}$/;
const text = (value: unknown) => (typeof value === "string" && SAFE.test(value) ? value : null);
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

export function buildGenerationEvent(input: Partial<Record<keyof GenerationEvent, unknown>>): GenerationEvent {
  const outcome = input.outcome === "succeeded" || input.outcome === "rejected" ? input.outcome : "failed";
  const costSource =
    input.costSource === "provider_usage" || input.costSource === "unavailable" ? input.costSource : "not_applicable";
  const costUsd = costSource === "provider_usage" ? count(input.costUsd) : null;
  return {
    event: "generation",
    requestId: text(input.requestId) ?? "unknown",
    outcome,
    reason: text(input.reason) ?? "unknown",
    httpStatus: count(input.httpStatus) ?? 0,
    commandId: text(input.commandId),
    lane: text(input.lane),
    recipeId: text(input.recipeId),
    recipeVersion: text(input.recipeVersion),
    modelId: text(input.modelId),
    latencyMs: Math.round(count(input.latencyMs) ?? 0),
    providerLatencyMs: count(input.providerLatencyMs) === null ? null : Math.round(count(input.providerLatencyMs) as number),
    providerStatus: count(input.providerStatus),
    costUsd,
    costSource,
    errorName: text(input.errorName),
  };
}

/** Default sink: one JSON line per generation attempt on stdout. */
export const consoleTelemetry: TelemetrySink = (event) => {
  console.info(JSON.stringify(event));
};
