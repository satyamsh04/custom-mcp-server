import { z } from "zod";
import { getDynamoClient, PutCommand } from "../clients/dynamo-client.js";
import { loadConfig } from "../config.js";
import { createAppError, isAppError } from "../errors.js";
import { MAX_ITEM_BYTES, OWNER_ATTR } from "../security.js";
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
  ctx: AuthContext,
): Promise<ToolResult> {
  const config = loadConfig();
  const overwrite = input.overwrite ?? true;
  // Owner is stamped last so a caller cannot spoof it via `attributes`.
  const item = { ...input.attributes, id: input.id, [OWNER_ATTR]: ctx.subject };

  // Guard against oversized items (DynamoDB hard-limits at 400 KB; we cap
  // lower). Rough byte estimate via JSON serialization of the attributes.
  if (Buffer.byteLength(JSON.stringify(item), "utf8") > MAX_ITEM_BYTES) {
    throw createAppError(
      "PAYLOAD_TOO_LARGE",
      `item exceeds ${MAX_ITEM_BYTES} bytes`,
      false,
    );
  }

  // overwrite=false → create-only (fail if id exists at all).
  // overwrite=true  → create OR update only records the caller owns.
  const condition = overwrite
    ? "attribute_not_exists(id) OR #owner = :owner"
    : "attribute_not_exists(id)";

  try {
    await getDynamoClient().send(
      new PutCommand({
        TableName: config.dynamoTable,
        Item: item,
        ConditionExpression: condition,
        ExpressionAttributeNames: { "#owner": OWNER_ATTR },
        ExpressionAttributeValues: { ":owner": ctx.subject },
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
      // With overwrite, a failure means the record exists and is owned by
      // someone else (authorization). Without it, the id simply already exists.
      if (overwrite) {
        throw createAppError(
          "FORBIDDEN",
          `not authorized to overwrite record "${input.id}"`,
          false,
        );
      }
      throw createAppError(
        "DYNAMO_CONFLICT",
        `record "${input.id}" already exists`,
        false,
      );
    }
    throw createAppError("DYNAMO_WRITE_FAILED", message, true);
  }
}

const tool: ToolModule<DynamoWriteInput> = {
  definition,
  requiredScopes: ["dynamo:write"],
  schema,
  handler,
};
export default tool;
