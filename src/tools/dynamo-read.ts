import { z } from "zod";
import { getDynamoClient, GetCommand } from "../clients/dynamo-client.js";
import { loadConfig } from "../config.js";
import { createAppError, isAppError } from "../errors.js";
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
  _ctx: AuthContext,
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

    if (res.Item === undefined) {
      return {
        content: [{ type: "text", text: JSON.stringify({ found: false }) }],
      };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(res.Item) }],
    };
  } catch (err) {
    if (isAppError(err)) throw err;
    const message = err instanceof Error ? err.message : "read failed";
    throw createAppError("DYNAMO_READ_FAILED", message, true);
  }
}

const tool: ToolModule<DynamoReadInput> = { definition, schema, handler };
export default tool;
