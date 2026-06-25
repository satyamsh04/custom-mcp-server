import { jest } from "@jest/globals";
import { withRetry } from "../../src/middleware/retry.js";
import { createAppError } from "../../src/errors.js";

const noSleep = async (): Promise<void> => undefined;

describe("withRetry", () => {
  it("succeeds on first try → fn called once", async () => {
    const fn = jest.fn<() => Promise<string>>().mockResolvedValue("ok");
    const result = await withRetry(fn, { sleep: noSleep });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("fails twice then succeeds → fn called 3 times, returns value", async () => {
    const retryable = createAppError("X", "transient", true);
    const fn = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(retryable)
      .mockRejectedValueOnce(retryable)
      .mockResolvedValue("done");
    const result = await withRetry(fn, { maxAttempts: 3, sleep: noSleep });
    expect(result).toBe("done");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("non-retryable error → fn called once, throws", async () => {
    const fatal = createAppError("FATAL", "nope", false);
    const fn = jest.fn<() => Promise<string>>().mockRejectedValue(fatal);
    await expect(withRetry(fn, { sleep: noSleep })).rejects.toBe(fatal);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("exhausts attempts → throws last error, called maxAttempts times", async () => {
    const retryable = createAppError("X", "transient", true);
    const fn = jest.fn<() => Promise<string>>().mockRejectedValue(retryable);
    await expect(
      withRetry(fn, { maxAttempts: 3, sleep: noSleep }),
    ).rejects.toBe(retryable);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("delays follow exponential pattern (baseDelay * 2^(n-1))", async () => {
    const retryable = createAppError("X", "transient", true);
    const fn = jest.fn<() => Promise<string>>().mockRejectedValue(retryable);
    const delays: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      delays.push(ms);
    };
    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 200, sleep }),
    ).rejects.toBe(retryable);
    // Two retries before the final throw: 200 * 2^0, 200 * 2^1
    expect(delays).toEqual([200, 400]);
  });
});
