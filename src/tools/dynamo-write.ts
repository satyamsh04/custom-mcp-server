import { z } from "zod";
import { getDynamoClient, PutCommand } from "../clients/dynamo-client.js";
import { loadConfig } from "../config.js";
import { createAppError, isAppError } from "../errors.js";
import type { AuthContext, ToolModule, ToolResult } from "../types.js";

export interface DynamoWriteInput {
  id: string;
  attributes: Record<string, unknown>;
  overwrite?: boolean;
}

export const schema = z
  .object({
    id: z.string().min(1),
    attributes: z.record(z.string(), z.unknown()),
    overwrite: z.boolean().optional(),
  })
  .strict();

const definition = {
  name: "dynamo_write",
  description: "Write a record to DynamoDB keyed by 'id'.",
  inputSchema: {
    type: "object" as const,
    properties: {
      id: {
        type: "string",
        minLength: 1,
        description: "Primary key 'id' for the record",
      },
      attributes: {
        type: "object",
        description: "Arbitrary attributes to store with the record",
        additionalProperties: true,
      },
      overwrite: {
        type: "boolean",
        default: true,
        description: "If false, fail when item already exists",
      },
    },
    required: ["id", "attributes"],
    additionalProperties: false,
  },
};

async function handler(
  input: DynamoWriteInput,
  _ctx: AuthContext,
): Promise<ToolResult> {
  const config = loadConfig();
  const overwrite = input.overwrite ?? true;
  const item = { id: input.id, ...input.attributes };

  try {
    await getDynamoClient().send(
      new PutCommand({
        TableName: config.dynamoTable,
        Item: item,
        ...(overwrite
          ? {}
          : { ConditionExpression: "attribute_not_exists(id)" }),
      }),
    );

    return {
      content: [
        { type: "text", text: JSON.stringify({ id: input.id, written: true }) },
      ],
    };
  } catch (err) {
    if (isAppError(err)) throw err;
    const name = err instanceof Error ? err.name : "";
    const message = err instanceof Error ? err.message : "write failed";
    if (name === "ConditionalCheckFailedException") {
      throw createAppError(
        "DYNAMO_CONFLICT",
        `record "${input.id}" already exists`,
        false,
      );
    }
    throw createAppError("DYNAMO_WRITE_FAILED", message, true);
  }
}

const tool: ToolModule<DynamoWriteInput> = { definition, schema, handler };
export default tool;
