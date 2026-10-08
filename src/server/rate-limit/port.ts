export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export interface RateLimitPort {
  consume(userId: string): Promise<RateLimitDecision>;
}
