// Shared types & interface contracts (PLAN.md Section 2).
// These are imported across the whole project. Every tool conforms to ToolModule.

import type { ZodType } from "zod";

// JSON Schema object as accepted by MCP SDK inputSchema
export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

// Standard MCP tool result content
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// The auth context produced by oauth.ts and passed to every handler
export interface AuthContext {
  subject: string; // JWT `sub`
  scopes: string[]; // JWT `scope` split on space
  raw: Record<string, unknown>; // full decoded claims
}

// Each tool file exports this shape
export interface ToolModule<TInput = unknown> {
  definition: ToolDefinition;
  // zod schema the server parses input against before invoking the handler
  schema: ZodType<TInput>;
  // validated input is guaranteed to match the zod schema before handler runs
  handler: (input: TInput, ctx: AuthContext) => Promise<ToolResult>;
}

export interface AppError {
  code: string; // e.g. "S3_UPLOAD_FAILED"
  message: string;
  retryable: boolean;
}
