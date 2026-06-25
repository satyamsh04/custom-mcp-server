import { z } from "zod";
import { getS3Client, GetObjectCommand } from "../clients/s3-client.js";
import { loadConfig } from "../config.js";
import { createAppError, isAppError } from "../errors.js";
import { MAX_OBJECT_BYTES, scopedObjectKey } from "../security.js";
import type { AuthContext, ToolModule, ToolResult } from "../types.js";

export interface S3DownloadInput {
  key: string;
}

export const schema = z
  .object({
    key: z.string().min(1),
  })
  .strict();

const definition = {
  name: "s3_download",
  description:
    "Download an object from S3 (scoped to the caller) base64-encoded.",
  inputSchema: {
    type: "object" as const,
    properties: {
      key: {
        type: "string",
        minLength: 1,
        description: "S3 object key/path to fetch",
      },
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
  ctx: AuthContext,
): Promise<ToolResult> {
  const config = loadConfig();
  const bucket = config.s3Bucket;
  const key = scopedObjectKey(ctx, input.key);

  try {
    const res = await getS3Client().send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );

    if (res.Body === undefined) {
      throw createAppError("S3_DOWNLOAD_FAILED", "empty response body", false);
    }

    // Reject oversized objects before buffering them into memory.
    if (
      typeof res.ContentLength === "number" &&
      res.ContentLength > MAX_OBJECT_BYTES
    ) {
      throw createAppError(
        "PAYLOAD_TOO_LARGE",
        `object exceeds ${MAX_OBJECT_BYTES} bytes`,
        false,
      );
    }

    const bytes = await (
      res.Body as unknown as ByteStream
    ).transformToByteArray();

    if (bytes.byteLength > MAX_OBJECT_BYTES) {
      throw createAppError(
        "PAYLOAD_TOO_LARGE",
        `object exceeds ${MAX_OBJECT_BYTES} bytes`,
        false,
      );
    }

    const contentBase64 = Buffer.from(bytes).toString("base64");

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            bucket,
            key,
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

const tool: ToolModule<S3DownloadInput> = {
  definition,
  requiredScopes: ["s3:read"],
  schema,
  handler,
};
export default tool;
