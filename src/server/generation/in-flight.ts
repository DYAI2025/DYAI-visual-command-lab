/**
 * At most one generation per key (principal) at a time, so a double submit or a retry storm from one
 * caller cannot start parallel paid provider calls. Process-local, like the other MVP guards.
 */
export function createInFlightGuard() {
  const active = new Set<string>();
  return {
    /** Returns a release function, or null when the key already has a generation running. */
    tryAcquire(key: string): (() => void) | null {
      if (active.has(key)) return null;
      active.add(key);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active.delete(key);
      };
    },
  };
}

export type InFlightGuard = ReturnType<typeof createInFlightGuard>;
