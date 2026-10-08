import { createHash, timingSafeEqual } from "node:crypto";
import type { AuthPort, AuthPrincipal } from "./port.ts";

export class AuthenticationRequiredError extends Error {
  constructor() {
    super("A valid credential is required");
    this.name = "AuthenticationRequiredError";
  }
}

export interface IntegrationTokenAuthOptions {
  /** Hex SHA-256 of the bearer token. The token itself is never configured on the server. */
  tokenSha256: string;
  principalId: string;
}

/**
 * Operator-provisioned integration principal for exercising the generation boundary before real user
 * authentication exists (DYAI-35). It is active only when AUTH_PROVIDER=integration_token and a token
 * hash are configured explicitly; the default runtime has no principal at all. One configured token
 * maps to one fixed principal. Not a user login and not intended for public deployment.
 */
export function createIntegrationTokenAuth(options: IntegrationTokenAuthOptions): AuthPort {
  const expected = Buffer.from(options.tokenSha256, "hex");
  const principal: AuthPrincipal = { userId: options.principalId };
  return {
    async requirePrincipal(request: Request) {
      const match = /^Bearer ([\x21-\x7e]+)$/.exec(request.headers.get("authorization") ?? "");
      if (!match) throw new AuthenticationRequiredError();
      const presented = createHash("sha256").update(match[1]).digest();
      if (!timingSafeEqual(presented, expected)) throw new AuthenticationRequiredError();
      return principal;
    },
  };
}
