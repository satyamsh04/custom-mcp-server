import { createRateLimiter } from "../../src/middleware/rate-limiter.js";
import { isAppError } from "../../src/errors.js";

describe("createRateLimiter", () => {
  it("allows up to the limit within the window", () => {
    const rl = createRateLimiter(3, () => 1000);
    expect(() => {
      rl.check("s3_upload");
      rl.check("s3_upload");
      rl.check("s3_upload");
    }).not.toThrow();
  });

  it("throws RATE_LIMITED on the call past the limit", () => {
    const rl = createRateLimiter(2, () => 1000);
    rl.check("s3_upload");
    rl.check("s3_upload");
    try {
      rl.check("s3_upload");
      fail("expected RATE_LIMITED to throw");
    } catch (err) {
      expect(isAppError(err)).toBe(true);
      if (isAppError(err)) {
        expect(err.code).toBe("RATE_LIMITED");
        expect(err.retryable).toBe(true);
      }
    }
  });

  it("keeps independent counters per tool", () => {
    const rl = createRateLimiter(1, () => 1000);
    rl.check("s3_upload");
    expect(() => rl.check("s3_download")).not.toThrow();
    expect(() => rl.check("s3_upload")).toThrow();
  });

  it("resets the counter once the window advances", () => {
    let current = 1000;
    const rl = createRateLimiter(1, () => current);
    rl.check("s3_upload");
    expect(() => rl.check("s3_upload")).toThrow();
    current += 60_000; // advance past the window
    expect(() => rl.check("s3_upload")).not.toThrow();
  });
});
