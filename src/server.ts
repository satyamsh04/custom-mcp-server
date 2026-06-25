import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { tools as defaultTools } from "./tools/index.js";
import { validateJwt as defaultValidateJwt } from "./auth/oauth.js";
import {
  createRateLimiter,
  type RateLimiter,
} from "./middleware/rate-limiter.js";
import { withRetry } from "./middleware/retry.js";
import { loadConfig } from "./config.js";
import { createAppError, isAppError } from "./errors.js";
import { log } from "./logger.js";
import type { AuthContext, ToolModule, ToolResult } from "./types.js";

export interface DispatchDeps {
  tools: Record<string, ToolModule>;
  rateLimiter: RateLimiter;
  validate: (token: string) => Promise<AuthContext>;
  retryOptions?: { maxAttempts?: number; baseDelayMs?: number };
}

// Single tool-call pipeline: auth → rate limit → validate → retry(handler).
// Exported so it can be unit-tested without a transport.
export async function dispatchToolCall(
  name: string,
  args: unknown,
  token: string,
  deps: DispatchDeps,
): Promise<ToolResult> {
  // 1. Auth on every call.
  const ctx = await deps.validate(token);

  // 2. Rate limit per tool.
  deps.rateLimiter.check(name);

  // 3. Look up the tool (guarded for noUncheckedIndexedAccess).
  const tool = deps.tools[name];
  if (tool === undefined) {
    throw createAppError("UNKNOWN_TOOL", `unknown tool "${name}"`, false);
  }

  // 4. Validate input.
  const parseResult = tool.schema.safeParse(args ?? {});
  if (!parseResult.success) {
    throw createAppError(
      "INVALID_PARAMS",
      parseResult.error.issues.map((i) => i.message).join("; "),
      false,
    );
  }

  // 5. Run the handler with retry/backoff.
  return withRetry(() => tool.handler(parseResult.data, ctx), deps.retryOptions);
}

function extractToken(meta: Record<string, unknown> | undefined): string {
  const raw = meta?.authorization;
  if (typeof raw !== "string") return "";
  return raw.replace(/^Bearer\s+/i, "").trim();
}

export function createServer(deps?: Partial<DispatchDeps>): Server {
  const config = loadConfig();
  const resolvedDeps: DispatchDeps = {
    tools: deps?.tools ?? defaultTools,
    rateLimiter: deps?.rateLimiter ?? createRateLimiter(config.rateLimitPerMin),
    validate: deps?.validate ?? defaultValidateJwt,
    retryOptions: deps?.retryOptions ?? {
      maxAttempts: config.retryMaxAttempts,
      baseDelayMs: config.retryBaseDelayMs,
    },
  };

  const server = new Server(
    { name: "custom-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.values(resolvedDeps.tools).map((t) => t.definition),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const token = extractToken(
      request.params._meta as Record<string, unknown> | undefined,
    );
    try {
      const result = await dispatchToolCall(
        name,
        request.params.arguments,
        token,
        resolvedDeps,
      );
      return result as CallToolResult;
    } catch (err) {
      const code = isAppError(err) ? err.code : "INTERNAL_ERROR";
      const message = err instanceof Error ? err.message : String(err);
      log("error", "tool call failed", { tool: name, code, message });
      return {
        content: [{ type: "text", text: `${code}: ${message}` }],
        isError: true,
      } as CallToolResult;
    }
  });

  return server;
}

export async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("info", "custom-mcp-server started (stdio)");

  const shutdown = (signal: string): void => {
    log("info", `received ${signal}, shutting down`);
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Run only when invoked directly (not when imported by tests).
const invokedPath = process.argv[1] ?? "";
if (invokedPath.endsWith("server.js") || invokedPath.endsWith("server.ts")) {
  main().catch((err: unknown) => {
    log("error", "fatal startup error", {
      message: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
