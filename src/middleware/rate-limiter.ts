import { createAppError } from "../errors.js";

export interface RateLimiter {
  check(toolName: string): void; // throws AppError {code:"RATE_LIMITED"} if over limit
  reset(): void; // test helper
}

const WINDOW_MS = 60_000;

// In-memory fixed-window limiter, per tool name. State is per-process (see
// PLAN.md blocker B7). `now` is injectable for deterministic tests.
export function createRateLimiter(
  limitPerMin = 100,
  now: () => number = Date.now,
): RateLimiter {
  // toolName -> { windowStart, count }
  const windows = new Map<string, { windowStart: number; count: number }>();

  return {
    check(toolName: string): void {
      const ts = now();
      const existing = windows.get(toolName);

      if (existing === undefined || ts - existing.windowStart >= WINDOW_MS) {
        windows.set(toolName, { windowStart: ts, count: 1 });
        return;
      }

      if (existing.count >= limitPerMin) {
        throw createAppError(
          "RATE_LIMITED",
          `Rate limit of ${limitPerMin} req/min exceeded for tool "${toolName}"`,
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
