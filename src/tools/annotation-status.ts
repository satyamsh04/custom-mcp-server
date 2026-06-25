import { z } from "zod";
import {
  getDynamoClient,
  GetCommand,
  UpdateCommand,
} from "../clients/dynamo-client.js";
import { getSlackClient } from "../clients/slack-client.js";
import { loadConfig } from "../config.js";
import { createAppError, isAppError } from "../errors.js";
import { OWNER_ATTR, assertScopes, sanitizeSlackText } from "../security.js";
import type { AuthContext, ToolModule, ToolResult } from "../types.js";

const STATUSES = ["pending", "in_progress", "completed", "rejected"] as const;

export interface AnnotationStatusInput {
  taskId: string;
  newStatus?: (typeof STATUSES)[number];
  notify?: boolean;
}

export const schema = z
  .object({
    taskId: z.string().min(1),
    newStatus: z.enum(STATUSES).optional(),
    notify: z.boolean().optional(),
  })
  .strict();

const definition = {
  name: "annotation_status",
  description:
    "Read or update an annotation task's status, optionally notifying Slack.",
  inputSchema: {
    type: "object" as const,
    properties: {
      taskId: {
        type: "string",
        minLength: 1,
        description: "Annotation task identifier (Dynamo 'id')",
      },
      newStatus: {
        type: "string",
        enum: [...STATUSES],
        description: "If provided, update the task status",
      },
      notify: {
        type: "boolean",
        default: false,
        description: "If true, post the status to Slack",
      },
    },
    required: ["taskId"],
    additionalProperties: false,
  },
};

async function handler(
  input: AnnotationStatusInput,
  ctx: AuthContext,
): Promise<ToolResult> {
  const config = loadConfig();
  const client = getDynamoClient();

  // INTENTIONAL dual-scope pattern: the module declares `annotation:read` as
  // its dispatch-level requiredScope (so any caller can read). Mutating the
  // status additionally requires `annotation:write`, asserted here because the
  // requirement is conditional on `newStatus` being present and so cannot be
  // expressed in the static `requiredScopes` list. Do NOT remove this check as
  // "redundant" — the dispatcher does not know about the write path.
  if (input.newStatus !== undefined) {
    assertScopes(ctx, ["annotation:write"]);
  }

  try {
    const res = await client.send(
      new GetCommand({
        TableName: config.dynamoTable,
        Key: { id: input.taskId },
      }),
    );

    // Records owned by another principal are reported as not-found to avoid
    // leaking the existence of foreign task IDs.
    if (res.Item === undefined || res.Item[OWNER_ATTR] !== ctx.subject) {
      throw createAppError(
        "ANNOTATION_NOT_FOUND",
        `annotation task "${input.taskId}" not found`,
        false,
      );
    }

    let status =
      typeof res.Item.status === "string" ? res.Item.status : "unknown";
    let updatedAt: string | undefined;

    if (input.newStatus !== undefined) {
      updatedAt = new Date().toISOString();
      // Re-assert ownership at write time (guards the read→write TOCTOU gap).
      await client.send(
        new UpdateCommand({
          TableName: config.dynamoTable,
          Key: { id: input.taskId },
          UpdateExpression: "SET #s = :s, updatedAt = :u",
          ConditionExpression: "#owner = :owner",
          ExpressionAttributeNames: { "#s": "status", "#owner": OWNER_ATTR },
          ExpressionAttributeValues: {
            ":s": input.newStatus,
            ":u": updatedAt,
            ":owner": ctx.subject,
          },
        }),
      );
      status = input.newStatus;
    }

    if (input.notify === true) {
      await getSlackClient().chat.postMessage({
        channel: config.slackDefaultChannel,
        text: sanitizeSlackText(
          `Annotation task ${input.taskId} status: ${status}`,
        ),
      });
    }

    const payload: Record<string, unknown> = { taskId: input.taskId, status };
    if (updatedAt !== undefined) payload.updatedAt = updatedAt;

    return { content: [{ type: "text", text: JSON.stringify(payload) }] };
  } catch (err) {
    if (isAppError(err)) throw err;
    const message = err instanceof Error ? err.message : "annotation failed";
    throw createAppError("ANNOTATION_STATUS_FAILED", message, true);
  }
}

const tool: ToolModule<AnnotationStatusInput> = {
  definition,
  requiredScopes: ["annotation:read"],
  schema,
  handler,
};
export default tool;
