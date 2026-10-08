import type { QuotaDecision, RateLimitDecision, RateLimitPort } from "./port.ts";

export interface WindowLimit {
  max: number;
  windowSeconds: number;
}

export interface MemoryRateLimiterOptions {
  burst: WindowLimit;
  quota: WindowLimit;
  now?: () => number;
  /** Upper bound on principals held in memory per window; the least recently admitted is dropped first. */
  maxTrackedPrincipals?: number;
}

interface Entry {
  at: number;
  pending: boolean;
}

/**
 * Sliding window: at most `max` entries per key in any `windowSeconds`. Pending entries (reserved,
 * not yet committed) count toward the limit; a released entry is removed.
 */
function slidingWindow({ max, windowSeconds }: WindowLimit, now: () => number, maxTracked: number) {
  const windowMs = windowSeconds * 1000;
  const entries = new Map<string, Entry[]>();

  return {
    take(key: string): { allowed: true; entry: Entry } | { allowed: false; retryAfterSeconds: number } {
      const at = now();
      const live = (entries.get(key) ?? []).filter((entry) => entry.pending || entry.at > at - windowMs);
      if (live.length >= max) {
        entries.set(key, live);
        const settled = live.filter((entry) => !entry.pending);
        // Only pending entries: retry once one of them settles; a short fixed hint is honest.
        const wait = settled.length > 0 ? settled[0].at + windowMs - at : 1000;
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(wait / 1000)) };
      }
      const entry: Entry = { at, pending: false };
      live.push(entry);
      entries.delete(key); // re-insert so Map order is least recently admitted first
      entries.set(key, live);
      while (entries.size > maxTracked) entries.delete(entries.keys().next().value as string);
      return { allowed: true, entry };
    },
    remove(key: string, entry: Entry) {
      const list = entries.get(key);
      if (list) entries.set(key, list.filter((item) => item !== entry));
    },
    size: () => entries.size,
  };
}

/**
 * Per-principal burst limit and generation quota held in this process's memory. State is per
 * process: several instances each keep their own counts, and a restart resets them. This is a
 * single-instance MVP limiter, not a distributed one. Rejected attempts are not recorded, so they do
 * not extend a window.
 */
export function createMemoryRateLimiter(options: MemoryRateLimiterOptions): RateLimitPort & { trackedPrincipals(): number } {
  const { now = Date.now, maxTrackedPrincipals = 10_000 } = options;
  const burst = slidingWindow(options.burst, now, maxTrackedPrincipals);
  const quota = slidingWindow(options.quota, now, maxTrackedPrincipals);

  return {
    async consume(userId: string): Promise<RateLimitDecision> {
      const decision = burst.take(userId);
      return decision.allowed ? { allowed: true } : { allowed: false, retryAfterSeconds: decision.retryAfterSeconds };
    },
    async reserve(userId: string): Promise<QuotaDecision> {
      const decision = quota.take(userId);
      if (!decision.allowed) return decision;
      const { entry } = decision;
      entry.pending = true;
      let settled = false;
      return {
        allowed: true,
        reservation: {
          commit() {
            if (settled) return;
            settled = true;
            entry.pending = false;
            entry.at = now();
          },
          release() {
            if (settled) return;
            settled = true;
            quota.remove(userId, entry);
          },
        },
      };
    },
    trackedPrincipals: () => Math.max(burst.size(), quota.size()),
  };
}
