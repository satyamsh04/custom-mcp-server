import { z } from "zod";
import { getS3Client, PutObjectCommand } from "../clients/s3-client.js";
import { loadConfig } from "../config.js";
import { createAppError, isAppError } from "../errors.js";
import { MAX_OBJECT_BYTES, scopedObjectKey } from "../security.js";
import type { AuthContext, ToolModule, ToolResult } from "../types.js";

export interface S3UploadInput {
  key: string;
  contentBase64: string;
  contentType?: string;
}

export const schema = z
  .object({
    key: z.string().min(1),
    contentBase64: z.string().min(1),
    contentType: z.string().optional(),
  })
  .strict();

const definition = {
  name: "s3_upload",
  description: "Upload a base64-encoded object to S3 (scoped to the caller).",
  inputSchema: {
    type: "object" as const,
    properties: {
      key: { type: "string", minLength: 1, description: "S3 object key/path" },
      contentBase64: {
        type: "string",
        minLength: 1,
        description: "File contents, base64-encoded",
      },
      contentType: {
        type: "string",
        description: "MIME type, e.g. image/png",
        default: "application/octet-stream",
      },
    },
    required: ["key", "contentBase64"],
    additionalProperties: false,
  },
};

async function handler(
  input: S3UploadInput,
  ctx: AuthContext,
): Promise<ToolResult> {
  const config = loadConfig();
  const bucket = config.s3Bucket;
  const key = scopedObjectKey(ctx, input.key);
  const body = Buffer.from(input.contentBase64, "base64");

  if (body.byteLength > MAX_OBJECT_BYTES) {
    throw createAppError(
      "PAYLOAD_TOO_LARGE",
      `upload exceeds ${MAX_OBJECT_BYTES} bytes`,
      false,
    );
  }

  try {
    const res = await getS3Client().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: input.contentType ?? "application/octet-stream",
      }),
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ bucket, key, etag: res.ETag }),
        },
      ],
    };
  } catch (err) {
    if (isAppError(err)) throw err;
    const message = err instanceof Error ? err.message : "upload failed";
    throw createAppError("S3_UPLOAD_FAILED", message, true);
  }
}

const tool: ToolModule<S3UploadInput> = {
  definition,
  requiredScopes: ["s3:write"],
  schema,
  handler,
};
export default tool;
