import type { RateLimitPort } from "./port";

export class RateLimitNotConfiguredError extends Error {
  constructor() {
    super("Rate-limit adapter is not configured");
    this.name = "RateLimitNotConfiguredError";
  }
}

export const rateLimiter: RateLimitPort = {
  async consume() {
    throw new RateLimitNotConfiguredError();
  },
};
