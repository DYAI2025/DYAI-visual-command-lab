import type { SpendDecision, SpendGuard, SpendOutcome, SpendReservation } from "./port.ts";

export interface MemorySpendGuardOptions {
  dailyBudgetUsd: number;
  /** Reserved per generation before the provider call; the most one generation is expected to cost. */
  maxCostPerRequestUsd: number;
  now?: () => number;
}

const MICRO = 1_000_000;
const toMicro = (usd: number) => Math.round(usd * MICRO);
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Daily (UTC) spend ledger held in this process's memory. Every in-flight generation holds a
 * reservation of `maxCostPerRequestUsd`, so concurrent requests cannot together pass the budget
 * check; settling replaces the reservation with the provider-reported cost, keeps it when the cost
 * is unknown, or releases it when the provider charged nothing. An actual cost above the
 * ceiling is recorded in full, so the budget can be exceeded by the overshoots of the generations that
 * were in flight together (one per principal; with the single integration principal, at most one). State is per
 * process and resets on restart: this is not a shared or durable budget.
 */
export function createMemorySpendGuard(options: MemorySpendGuardOptions): SpendGuard {
  const { now = Date.now } = options;
  const budget = toMicro(options.dailyBudgetUsd);
  const ceiling = toMicro(options.maxCostPerRequestUsd);
  let day = utcDay(now());
  let spent = 0;
  const open = new Map<number, number>();
  let nextId = 1;

  const roll = () => {
    const today = utcDay(now());
    if (today !== day) {
      day = today;
      spent = 0;
    }
  };
  const reserved = () => [...open.values()].reduce((sum, value) => sum + value, 0);

  return {
    reserve(): SpendDecision {
      roll();
      if (spent + reserved() + ceiling > budget) {
        const at = now();
        const nextDay = Date.UTC(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth(), new Date(at).getUTCDate() + 1);
        return { allowed: false, reason: "budget_exhausted", retryAfterSeconds: Math.max(1, Math.ceil((nextDay - at) / 1000)) };
      }
      const reservation: SpendReservation = { id: nextId++, microUsd: ceiling };
      open.set(reservation.id, ceiling);
      return { allowed: true, reservation };
    },
    settle(reservation: SpendReservation, outcome: SpendOutcome) {
      if (!open.delete(reservation.id)) return;
      roll();
      if (outcome.kind === "cost") spent += Math.max(0, toMicro(outcome.usd));
      else if (outcome.kind === "unknown") spent += reservation.microUsd;
    },
    snapshot() {
      roll();
      return { day, spentUsd: spent / MICRO, reservedUsd: reserved() / MICRO };
    },
  };
}
