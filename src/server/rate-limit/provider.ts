import type { RateLimitPort } from "./port.ts";
import { createMemoryRateLimiter } from "./memory.ts";
import type { GenerationConfig } from "../generation/config.ts";

/**
 * The active rate-limit adapter. Only the process-local memory adapter exists; a missing or unknown
 * RATE_LIMIT_PROVIDER fails closed in readGenerationConfig. A shared-store adapter replaces this
 * before any multi-instance deployment.
 */
export function createRateLimiter(config: GenerationConfig["rateLimit"]): RateLimitPort {
  switch (config.provider) {
    case "memory":
      return createMemoryRateLimiter({ burst: config.burst, quota: config.quota });
  }
}
