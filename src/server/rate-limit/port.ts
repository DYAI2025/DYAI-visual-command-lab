export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds?: number;
}

/** A generation-quota slot held while one generation runs. */
export interface QuotaReservation {
  /** The generation succeeded: the slot counts against the quota. */
  commit(): void;
  /** The generation failed or was blocked: the slot is returned. */
  release(): void;
}

export type QuotaDecision =
  | { allowed: true; reservation: QuotaReservation }
  | { allowed: false; retryAfterSeconds: number };

export interface RateLimitPort {
  /** Burst limit: every authenticated generation attempt counts, whatever its outcome. */
  consume(userId: string): Promise<RateLimitDecision>;
  /**
   * Generation quota: only successful generations count (DYAI-29). A slot is reserved before the
   * provider call so concurrent requests cannot overshoot, and released when the generation fails.
   */
  reserve(userId: string): Promise<QuotaDecision>;
}
