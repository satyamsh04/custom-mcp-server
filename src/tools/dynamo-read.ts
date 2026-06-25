import { z } from "zod";
import { getDynamoClient, GetCommand } from "../clients/dynamo-client.js";
import { loadConfig } from "../config.js";
import { createAppError, isAppError } from "../errors.js";
import { OWNER_ATTR } from "../security.js";
import type { AuthContext, ToolModule, ToolResult } from "../types.js";

export interface DynamoReadInput {
  id: string;
  consistentRead?: boolean;
}

export const schema = z
  .object({
    id: z.string().min(1),
    consistentRead: z.boolean().optional(),
  })
  .strict();

const definition = {
  name: "dynamo_read",
  description: "Read a single record from DynamoDB by primary key 'id'.",
  inputSchema: {
    type: "object" as const,
    properties: {
      id: {
        type: "string",
        minLength: 1,
        description: "Primary key (partition key 'id') of the record",
      },
      consistentRead: {
        type: "boolean",
        default: false,
        description: "Use strongly consistent read",
      },
    },
    required: ["id"],
    additionalProperties: false,
  },
};

async function handler(
  input: DynamoReadInput,
  ctx: AuthContext,
): Promise<ToolResult> {
  const config = loadConfig();

  try {
    const res = await getDynamoClient().send(
      new GetCommand({
        TableName: config.dynamoTable,
        Key: { id: input.id },
        ConsistentRead: input.consistentRead ?? false,
      }),
    );

    // Ownership check. A record owned by another principal is reported as
    // not-found so callers cannot enumerate foreign record IDs.
    if (res.Item === undefined || res.Item[OWNER_ATTR] !== ctx.subject) {
      return {
        content: [{ type: "text", text: JSON.stringify({ found: false }) }],
      };
    }

    // Do not echo the internal ownership attribute back to the caller.
    const { [OWNER_ATTR]: _owner, ...item } = res.Item;

    return {
      content: [{ type: "text", text: JSON.stringify(item) }],
    };
  } catch (err) {
    if (isAppError(err)) throw err;
    const message = err instanceof Error ? err.message : "read failed";
    throw createAppError("DYNAMO_READ_FAILED", message, true);
  }
}

const tool: ToolModule<DynamoReadInput> = {
  definition,
  requiredScopes: ["dynamo:read"],
  schema,
  handler,
};
export default tool;
