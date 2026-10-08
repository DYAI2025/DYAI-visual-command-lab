import { randomUUID } from "node:crypto";
import { commandRepository, recipeRepository } from "../catalogue/index.ts";
import { modelRegistry } from "../models/index.ts";
import { createAuth } from "../auth/provider.ts";
import { createRateLimiter } from "../rate-limit/provider.ts";
import { createMemorySpendGuard } from "../budget/memory.ts";
import { createOpenRouterClient } from "../openrouter/client.ts";
import { consoleTelemetry } from "../telemetry/generation.ts";
import { readDisabled, readGenerationConfig, readKillSwitch } from "./config.ts";
import { createInFlightGuard } from "./in-flight.ts";
import type { GenerationDeps, GenerationServices } from "./handler.ts";

// Process-wide composition for the route. The services, and with them the in-memory limiter, spend
// ledger and in-flight set, are built once per server process from its environment on the first
// request that finds a complete configuration. The kill switch and stop lists are re-read on every
// request. All state is per process (see docs/generation-boundary.md).

let services: GenerationServices | null = null;

function buildServices(): GenerationServices {
  const config = readGenerationConfig(process.env);
  return {
    auth: createAuth(config.auth),
    rateLimiter: createRateLimiter(config.rateLimit),
    spend: createMemorySpendGuard(config.budget),
    inFlight: createInFlightGuard(),
    provider: createOpenRouterClient({ ...config.provider, appUrl: config.provider.appUrl ?? undefined, maxOutputBytes: config.limits.maxOutputBytes }),
    limits: config.limits,
  };
}

export const runtimeDeps: GenerationDeps = {
  killSwitch: () => readKillSwitch(process.env),
  disabled: () => readDisabled(process.env),
  services: () => (services ??= buildServices()),
  sources: { commands: commandRepository, recipes: recipeRepository, models: modelRegistry },
  telemetry: consoleTelemetry,
  now: () => performance.now(),
  newRequestId: () => randomUUID(),
};
