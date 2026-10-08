import type { AuthPort } from "./port.ts";
import { createIntegrationTokenAuth } from "./integration-token.ts";
import type { GenerationConfig } from "../generation/config.ts";

/**
 * The active authentication adapter for the configured provider. The default runtime configures
 * none: readGenerationConfig rejects a missing or unknown AUTH_PROVIDER, so generation fails closed
 * before this is reached. DYAI-35 adds the real user-authentication adapter here.
 */
export function createAuth(config: GenerationConfig["auth"]): AuthPort {
  switch (config.provider) {
    case "integration_token":
      return createIntegrationTokenAuth(config);
  }
}
