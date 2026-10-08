export interface SpendReservation {
  readonly id: number;
  readonly microUsd: number;
}

export type SpendDecision =
  | { allowed: true; reservation: SpendReservation }
  | { allowed: false; reason: "budget_exhausted"; retryAfterSeconds: number };

/**
 * How a reserved generation ended for cost purposes: the provider-reported cost, an unknown cost
 * (the reservation is kept as the charge), or a request the provider rejected before generating.
 */
export type SpendOutcome = { kind: "cost"; usd: number } | { kind: "unknown" } | { kind: "not_charged" };

/** Global spend guardrail. A generation reserves its cost ceiling before the provider call. */
export interface SpendGuard {
  reserve(): SpendDecision;
  settle(reservation: SpendReservation, outcome: SpendOutcome): void;
  snapshot(): { day: string; spentUsd: number; reservedUsd: number };
}
