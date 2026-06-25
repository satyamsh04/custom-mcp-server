import { z } from "zod";
import { getS3Client, PutObjectCommand } from "../clients/s3-client.js";
import { loadConfig } from "../config.js";
import { createAppError, isAppError } from "../errors.js";
import type { AuthContext, ToolModule, ToolResult } from "../types.js";

export interface S3UploadInput {
  key: string;
  contentBase64: string;
  contentType?: string;
  bucket?: string;
}

export const schema = z
  .object({
    key: z.string().min(1),
    contentBase64: z.string().min(1),
    contentType: z.string().optional(),
    bucket: z.string().optional(),
  })
  .strict();

const definition = {
  name: "s3_upload",
  description: "Upload a base64-encoded object to S3.",
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
      bucket: { type: "string", description: "Override default S3 bucket" },
    },
    required: ["key", "contentBase64"],
    additionalProperties: false,
  },
};

async function handler(
  input: S3UploadInput,
  _ctx: AuthContext,
): Promise<ToolResult> {
  const config = loadConfig();
  const bucket = input.bucket ?? config.s3Bucket;
  const body = Buffer.from(input.contentBase64, "base64");

  try {
    const res = await getS3Client().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: input.key,
        Body: body,
        ContentType: input.contentType ?? "application/octet-stream",
      }),
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ bucket, key: input.key, etag: res.ETag }),
        },
      ],
    };
  } catch (err) {
    if (isAppError(err)) throw err;
    const message = err instanceof Error ? err.message : "upload failed";
    throw createAppError("S3_UPLOAD_FAILED", message, true);
  }
}

const tool: ToolModule<S3UploadInput> = { definition, schema, handler };
export default tool;
