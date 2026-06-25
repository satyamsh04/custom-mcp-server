import { isAppError } from "../errors.js";

export interface RetryOptions {
  maxAttempts?: number; // default 3
  baseDelayMs?: number; // default 200
  isRetryable?: (err: unknown) => boolean; // default: AppError.retryable === true
  // Injectable sleep for deterministic tests; defaults to real setTimeout.
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const defaultIsRetryable = (err: unknown): boolean =>
  isAppError(err) && err.retryable === true;

// Retries `fn` up to maxAttempts times. After a failed attempt n (1-indexed)
// it waits baseDelayMs * 2^(n-1) before the next attempt. Non-retryable errors
// rethrow immediately; the last error is rethrown after exhaustion.
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions,
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 200;
  const isRetryable = opts?.isRetryable ?? defaultIsRetryable;
  const sleep = opts?.sleep ?? defaultSleep;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (!isRetryable(err) || attempt === maxAttempts) {
        throw err;
      }

      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
  }

  throw lastError;
}
