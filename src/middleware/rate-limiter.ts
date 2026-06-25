import { createAppError } from "../errors.js";

export interface RateLimiter {
  // `key` is an opaque bucket identifier. The server keys by `subject:tool`.
  check(key: string): void; // throws AppError {code:"RATE_LIMITED"} if over limit
  reset(): void; // test helper
}

const WINDOW_MS = 60_000;

// In-memory fixed-window limiter keyed by an opaque bucket id. State is
// per-process (see PLAN.md blocker B7). `now` is injectable for deterministic
// tests.
//
// LIMITATION: because state lives in a process-local Map it (a) resets on
// restart and (b) is NOT shared across instances. This is acceptable for a
// single-process stdio MCP server. If this is ever deployed across multiple
// replicas / Lambda invocations (see README), replace this with a shared
// backend (Redis or DynamoDB with a TTL) so limits are enforced globally.
export function createRateLimiter(
  limitPerMin = 100,
  now: () => number = Date.now,
): RateLimiter {
  // key -> { windowStart, count }
  const windows = new Map<string, { windowStart: number; count: number }>();

  return {
    check(key: string): void {
      const ts = now();
      const existing = windows.get(key);

      if (existing === undefined || ts - existing.windowStart >= WINDOW_MS) {
        windows.set(key, { windowStart: ts, count: 1 });
        return;
      }

      if (existing.count >= limitPerMin) {
        throw createAppError(
          "RATE_LIMITED",
          `Rate limit of ${limitPerMin} req/min exceeded`,
          true,
        );
      }

      existing.count += 1;
    },

    reset(): void {
      windows.clear();
    },
  };
}
