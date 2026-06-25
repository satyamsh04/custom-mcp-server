import { z } from "zod";
import { getSlackClient } from "../clients/slack-client.js";
import { loadConfig } from "../config.js";
import { createAppError, isAppError } from "../errors.js";
import { sanitizeSlackText } from "../security.js";
import type { AuthContext, ToolModule, ToolResult } from "../types.js";

export interface SlackNotifyInput {
  message: string;
  channel?: string;
  threadTs?: string;
}

export const schema = z
  .object({
    message: z.string().min(1),
    channel: z.string().optional(),
    threadTs: z.string().optional(),
  })
  .strict();

const definition = {
  name: "slack_notify",
  description: "Post a message to a Slack channel.",
  inputSchema: {
    type: "object" as const,
    properties: {
      message: {
        type: "string",
        minLength: 1,
        description: "Text to post to Slack",
      },
      channel: {
        type: "string",
        description: "Channel ID or name; defaults to SLACK_DEFAULT_CHANNEL",
      },
      threadTs: {
        type: "string",
        description: "Optional parent message ts to reply in a thread",
      },
    },
    required: ["message"],
    additionalProperties: false,
  },
};

async function handler(
  input: SlackNotifyInput,
  _ctx: AuthContext,
): Promise<ToolResult> {
  void _ctx;
  const config = loadConfig();
  const channel = input.channel ?? config.slackDefaultChannel;

  try {
    const res = await getSlackClient().chat.postMessage({
      channel,
      text: sanitizeSlackText(input.message),
      thread_ts: input.threadTs,
    });

    if (res.ok !== true) {
      throw createAppError(
        "SLACK_NOTIFY_FAILED",
        "Slack returned ok:false",
        true,
      );
    }

    return {
      content: [
        { type: "text", text: JSON.stringify({ channel, ts: res.ts }) },
      ],
    };
  } catch (err) {
    if (isAppError(err)) throw err;
    const message = err instanceof Error ? err.message : "slack notify failed";
    throw createAppError("SLACK_NOTIFY_FAILED", message, true);
  }
}

const tool: ToolModule<SlackNotifyInput> = {
  definition,
  requiredScopes: ["slack:write"],
  schema,
  handler,
};
export default tool;
