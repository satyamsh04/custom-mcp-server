import { jest } from "@jest/globals";
import { z } from "zod";
import { dispatchToolCall, type DispatchDeps } from "../src/server.js";
import { createRateLimiter } from "../src/middleware/rate-limiter.js";
import { createAppError, isAppError } from "../src/errors.js";
import type { AuthContext, ToolModule } from "../src/types.js";

const ctx: AuthContext = { subject: "user-1", scopes: ["read"], raw: {} };

function makeStubTool(
  handler: ToolModule["handler"],
): ToolModule {
  return {
    definition: {
      name: "stub",
      description: "stub tool",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    },
    schema: z.object({ value: z.string() }).strict() as never,
    handler,
  };
}

function baseDeps(overrides?: Partial<DispatchDeps>): DispatchDeps {
  return {
    tools: { stub: makeStubTool(async () => ({ content: [{ type: "text", text: "ok" }] })) },
    rateLimiter: createRateLimiter(100),
    validate: async () => ctx,
    retryOptions: { maxAttempts: 3, baseDelayMs: 1 },
    ...overrides,
  };
}

describe("dispatchToolCall pipeline", () => {
  it("runs auth before anything else and rejects when auth fails", async () => {
    const handler = jest.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    const deps = baseDeps({
      tools: { stub: makeStubTool(handler) },
      validate: async () => {
        throw createAppError("AUTH_INVALID", "bad token", false);
      },
    });
    await expect(
      dispatchToolCall("stub", { value: "x" }, "tok", deps),
    ).rejects.toMatchObject({ code: "AUTH_INVALID" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("enforces the rate limit", async () => {
    const deps = baseDeps({ rateLimiter: createRateLimiter(1) });
    await dispatchToolCall("stub", { value: "x" }, "tok", deps);
    await expect(
      dispatchToolCall("stub", { value: "x" }, "tok", deps),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("rejects invalid input with INVALID_PARAMS", async () => {
    const deps = baseDeps();
    try {
      await dispatchToolCall("stub", { value: 123 }, "tok", deps);
      fail("expected INVALID_PARAMS");
    } catch (err) {
      expect(isAppError(err)).toBe(true);
      if (isAppError(err)) expect(err.code).toBe("INVALID_PARAMS");
    }
  });

  it("rejects unknown tools", async () => {
    const deps = baseDeps();
    await expect(
      dispatchToolCall("missing", {}, "tok", deps),
    ).rejects.toMatchObject({ code: "UNKNOWN_TOOL" });
  });

  it("retries a retryable handler error then succeeds", async () => {
    let calls = 0;
    const handler = jest.fn(async () => {
      calls += 1;
      if (calls < 2) throw createAppError("TRANSIENT", "retry me", true);
      return { content: [{ type: "text" as const, text: "recovered" }] };
    });
    const deps = baseDeps({ tools: { stub: makeStubTool(handler) } });
    const res = await dispatchToolCall("stub", { value: "x" }, "tok", deps);
    expect(res.content[0]!.text).toBe("recovered");
    expect(calls).toBe(2);
  });
});
