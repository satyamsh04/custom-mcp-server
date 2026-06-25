import { z } from "zod";
import { getS3Client, GetObjectCommand } from "../clients/s3-client.js";
import { loadConfig } from "../config.js";
import { createAppError, isAppError } from "../errors.js";
import type { AuthContext, ToolModule, ToolResult } from "../types.js";

export interface S3DownloadInput {
  key: string;
  bucket?: string;
}

export const schema = z
  .object({
    key: z.string().min(1),
    bucket: z.string().optional(),
  })
  .strict();

const definition = {
  name: "s3_download",
  description: "Download an object from S3 and return it base64-encoded.",
  inputSchema: {
    type: "object" as const,
    properties: {
      key: {
        type: "string",
        minLength: 1,
        description: "S3 object key/path to fetch",
      },
      bucket: { type: "string", description: "Override default S3 bucket" },
    },
    required: ["key"],
    additionalProperties: false,
  },
};

interface ByteStream {
  transformToByteArray: () => Promise<Uint8Array>;
}

async function handler(
  input: S3DownloadInput,
  _ctx: AuthContext,
): Promise<ToolResult> {
  const config = loadConfig();
  const bucket = input.bucket ?? config.s3Bucket;

  try {
    const res = await getS3Client().send(
      new GetObjectCommand({ Bucket: bucket, Key: input.key }),
    );

    if (res.Body === undefined) {
      throw createAppError(
        "S3_DOWNLOAD_FAILED",
        "empty response body",
        false,
      );
    }

    const bytes = await (res.Body as unknown as ByteStream).transformToByteArray();
    const contentBase64 = Buffer.from(bytes).toString("base64");

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            bucket,
            key: input.key,
            contentBase64,
            contentType: res.ContentType,
          }),
        },
      ],
    };
  } catch (err) {
    if (isAppError(err)) throw err;
    const name = err instanceof Error ? err.name : "";
    const message = err instanceof Error ? err.message : "download failed";
    const retryable = name !== "NoSuchKey";
    throw createAppError("S3_DOWNLOAD_FAILED", message, retryable);
  }
}

const tool: ToolModule<S3DownloadInput> = { definition, schema, handler };
export default tool;
