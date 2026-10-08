import type { AuthPort } from "./port";

export class AuthNotConfiguredError extends Error {
  constructor() {
    super("Authentication adapter is not configured");
    this.name = "AuthNotConfiguredError";
  }
}

export const auth: AuthPort = {
  async requirePrincipal() {
    throw new AuthNotConfiguredError();
  },
};
