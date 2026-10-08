import type { AuthPort } from "../auth/port.ts";
import type { RateLimitPort } from "../rate-limit/port.ts";
import type { SpendGuard } from "../budget/port.ts";
import { ContractInvalidError, ContractResolutionError } from "../../domain/contract/contract.ts";
import { EXECUTION_PROFILES, ProviderError, type ExecutionProfile, type ImageProvider, type ProviderErrorKind } from "../openrouter/client.ts";
import { buildGenerationEvent, type GenerationEvent, type TelemetrySink } from "../telemetry/generation.ts";
import { GenerationConfigError, type GenerationConfig } from "./config.ts";
import { inspectImage } from "./image.ts";
import type { InFlightGuard } from "./in-flight.ts";
import { composePrompt, resolveParameters } from "./prompt.ts";
import { GenerationRequestError, readGenerationRequest } from "./request.ts";
import { resolveCommandRef, resolveExecution, type ExecutionSources, type ResolvedExecution } from "./resolve.ts";

// POST /api/generate. Order of checks, each failing closed before anything later runs:
//   kill switch -> configuration -> authentication -> burst limit -> bounded body parse ->
//   command resolution -> command stop list -> recipe/model resolution (repositories + model
//   registry) -> model stop list -> source image and parameters ->
//   one in-flight generation per principal -> generation quota -> global spend reservation ->
//   provider call -> settle quota and spend.
// Nothing reaches the provider unless every earlier step passed.

export interface GenerationServices {
  auth: AuthPort;
  rateLimiter: RateLimitPort;
  spend: SpendGuard;
  inFlight: InFlightGuard;
  provider: ImageProvider;
  limits: GenerationConfig["limits"];
}

export interface GenerationDeps {
  killSwitch(): boolean;
  disabled(): { commands: ReadonlySet<string>; models: ReadonlySet<string> };
  /** Throws GenerationConfigError when the security boundary or provider is not configured. */
  services(): GenerationServices;
  /** Command and Recipe repositories plus the Model Capability registry (never static JSON). */
  sources: ExecutionSources;
  profiles?: Readonly<Record<string, ExecutionProfile>>;
  telemetry: TelemetrySink;
  /** Monotonic milliseconds. */
  now(): number;
  newRequestId(): string;
}

const PROVIDER_ERRORS: Record<ProviderErrorKind, { status: number; code: string }> = {
  timeout: { status: 504, code: "provider_timeout" },
  unreachable: { status: 502, code: "provider_unreachable" },
  rate_limited: { status: 503, code: "provider_busy" },
  unavailable: { status: 503, code: "provider_unavailable" },
  rejected_request: { status: 502, code: "provider_rejected_request" },
  rejected_image: { status: 422, code: "source_image_rejected" },
  content_refused: { status: 422, code: "content_refused" },
  failed: { status: 502, code: "provider_failed" },
  invalid_response: { status: 502, code: "provider_invalid_response" },
  no_image: { status: 502, code: "provider_invalid_response" },
};

const FAILURE_CODES = new Set([...Object.values(PROVIDER_ERRORS).map((entry) => entry.code), "generation_boundary_failed"]);

type Context = Partial<Record<keyof GenerationEvent, unknown>>;

export async function handleGenerate(request: Request, deps: GenerationDeps): Promise<Response> {
  const started = deps.now();
  const requestId = deps.newRequestId();
  const context: Context = { costSource: "not_applicable" };

  const finish = (
    status: number,
    body: Record<string, unknown>,
    options: { retryAfterSeconds?: number | null; headers?: Record<string, string> } = {},
  ): Response => {
    const succeeded = status === 200;
    deps.telemetry(
      buildGenerationEvent({
        ...context,
        requestId,
        outcome: succeeded ? "succeeded" : FAILURE_CODES.has(String(body.error)) ? "failed" : "rejected",
        reason: succeeded ? "ok" : body.error,
        httpStatus: status,
        latencyMs: deps.now() - started,
      }),
    );
    const headers: Record<string, string> = { "Cache-Control": "no-store", "X-Request-Id": requestId, ...options.headers };
    if (options.retryAfterSeconds) headers["Retry-After"] = String(options.retryAfterSeconds);
    const payload = succeeded
      ? { ...body, requestId }
      : { ...body, requestId, ...(options.retryAfterSeconds ? { retryAfterSeconds: options.retryAfterSeconds } : {}) };
    return Response.json(payload, { status, headers });
  };
  const fail = (status: number, error: string, retryAfterSeconds?: number | null, headers?: Record<string, string>) =>
    finish(status, { error }, { retryAfterSeconds, headers });

  try {
    if (deps.killSwitch()) return fail(503, "generation_disabled");

    let services: GenerationServices;
    try {
      services = deps.services();
    } catch (error) {
      if (error instanceof GenerationConfigError) {
        return fail(503, error.area === "provider" ? "provider_not_configured" : "server_security_boundary_not_configured");
      }
      throw error;
    }

    let userId: string;
    try {
      userId = (await services.auth.requirePrincipal(request)).userId;
    } catch (error) {
      if (error instanceof Error && error.name === "AuthenticationRequiredError") {
        return fail(401, "authentication_required", null, { "WWW-Authenticate": "Bearer" });
      }
      throw error;
    }

    const burst = await services.rateLimiter.consume(userId);
    if (!burst.allowed) return fail(429, "rate_limited", burst.retryAfterSeconds ?? 1);

    const input = await readGenerationRequest(request, services.limits.maxUploadBytes);

    let command;
    try {
      command = await resolveCommandRef(input.commandRef, deps.sources.commands);
    } catch (error) {
      if (error instanceof ContractResolutionError) return fail(404, "command_not_found");
      throw error;
    }
    Object.assign(context, { commandId: command.id, lane: command.lane });
    if (deps.disabled().commands.has(command.id)) return fail(503, "command_disabled");

    let execution: ResolvedExecution;
    try {
      execution = await resolveExecution(command, deps.sources);
    } catch (error) {
      if (error instanceof ContractResolutionError) return finish(422, { error: "command_not_executable", detail: error.code.toLowerCase() });
      // The command, recipe and registry the repositories returned do not form a valid contract.
      if (error instanceof ContractInvalidError) return fail(503, "execution_not_configured");
      throw error;
    }
    const { recipe, model, adapter, plan } = execution;
    Object.assign(context, { recipeId: plan.recipeId, recipeVersion: plan.recipeVersion, modelId: plan.modelId });
    if (deps.disabled().models.has(plan.modelId)) return fail(503, "model_disabled");

    const profile = (deps.profiles ?? EXECUTION_PROFILES)[plan.modelId];
    if (!profile) return fail(503, "execution_not_configured");

    // Source image: exactly what the command, recipe and model accept, checked on the bytes.
    const maxImages = Math.min(command.inputRequirements.maxSourceImages, model.capabilities.maxReferenceImages);
    if (input.images.length === 0) return fail(400, "image_required");
    if (input.images.length > maxImages) return fail(400, "too_many_images");
    const [source] = input.images;
    const info = inspectImage(source.bytes);
    if (!info || !command.inputRequirements.acceptedMimeTypes.includes(info.mimeType)) return fail(415, "unsupported_image_type");
    if (source.declaredType && source.declaredType !== "application/octet-stream" && source.declaredType !== info.mimeType) {
      return fail(400, "image_type_mismatch");
    }
    const { minImageEdgePx, maxImageEdgePx } = services.limits;
    if (Math.min(info.width, info.height) < minImageEdgePx || Math.max(info.width, info.height) > maxImageEdgePx) {
      return fail(422, "image_dimensions_out_of_range");
    }
    const prompt = composePrompt(recipe, adapter.promptOverrides, resolveParameters(recipe, input.parameters));

    const release = services.inFlight.tryAcquire(userId);
    if (!release) return fail(409, "generation_in_flight");
    try {
      const quota = await services.rateLimiter.reserve(userId);
      if (!quota.allowed) return fail(429, "quota_exceeded", quota.retryAfterSeconds);
      const spend = services.spend.reserve();
      if (!spend.allowed) {
        quota.reservation.release();
        return fail(503, spend.reason, spend.retryAfterSeconds);
      }
      if (deps.killSwitch()) {
        services.spend.settle(spend.reservation, { kind: "not_charged" });
        quota.reservation.release();
        return fail(503, "generation_disabled");
      }

      const providerStarted = deps.now();
      let result;
      try {
        result = await services.provider.generate({
          providerModelId: model.providerModelId,
          profile,
          prompt,
          sourceImage: { mimeType: info.mimeType, bytes: source.bytes },
          principalId: userId,
        });
      } catch (error) {
        context.providerLatencyMs = deps.now() - providerStarted;
        quota.reservation.release();
        if (error instanceof ProviderError) {
          services.spend.settle(spend.reservation, error.charge);
          Object.assign(context, { providerStatus: error.providerStatus, costSource: "unavailable" });
          const mapped = PROVIDER_ERRORS[error.kind];
          return fail(mapped.status, mapped.code, error.retryAfterSeconds);
        }
        services.spend.settle(spend.reservation, { kind: "unknown" });
        throw error;
      }
      context.providerLatencyMs = deps.now() - providerStarted;
      context.providerStatus = result.providerStatus;
      services.spend.settle(spend.reservation, result.costUsd === null ? { kind: "unknown" } : { kind: "cost", usd: result.costUsd });
      quota.reservation.commit();
      Object.assign(context, result.costUsd === null ? { costSource: "unavailable" } : { costSource: "provider_usage", costUsd: result.costUsd });

      return finish(200, {
        status: "succeeded",
        command: { id: command.id, slash: command.canonicalSlash, lane: command.lane },
        recipe: { id: plan.recipeId, version: plan.recipeVersion, truthMode: plan.truthMode },
        // Every Visual Command Lab output is a synthetic AI visualisation (04.1 §4).
        synthetic: true,
        output: {
          mimeType: result.image.mimeType,
          width: result.image.width,
          height: result.image.height,
          byteLength: result.image.bytes.byteLength,
          base64: Buffer.from(result.image.bytes).toString("base64"),
        },
      });
    } finally {
      release();
    }
  } catch (error) {
    if (error instanceof GenerationRequestError) return fail(error.status, error.code);
    // The class name only (telemetry sanitizes it); never the message, which may carry data.
    context.errorName = error instanceof Error ? error.name : typeof error;
    return fail(500, "generation_boundary_failed");
  }
}
