import { mockClient } from "aws-sdk-client-mock";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import tool, { schema } from "../../src/tools/s3-upload.js";
import type { AuthContext } from "../../src/types.js";
import { isAppError } from "../../src/errors.js";
import { setTestEnv } from "../helpers/env.js";

const s3Mock = mockClient(S3Client);

const ctx: AuthContext = { subject: "user-1", scopes: [], raw: {} };

beforeEach(() => {
  s3Mock.reset();
  setTestEnv();
});

describe("s3_upload", () => {
  it("declares the s3:write scope", () => {
    expect(tool.requiredScopes).toEqual(["s3:write"]);
  });

  it("uploads under the caller's prefix and returns key & etag", async () => {
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"abc123"' });
    const res = await tool.handler(
      {
        key: "path/file.png",
        contentBase64: Buffer.from("hi").toString("base64"),
      },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0]!.text);
    expect(payload.key).toBe("user-1/path/file.png");
    expect(payload.etag).toBe('"abc123"');
    expect(payload.bucket).toBe("annotation-artifacts");
    const calls = s3Mock.commandCalls(PutObjectCommand);
    expect(calls[0]!.args[0].input.Key).toBe("user-1/path/file.png");
    expect(calls[0]!.args[0].input.Bucket).toBe("annotation-artifacts");
  });

  it("rejects invalid input via schema (missing key)", () => {
    const parsed = schema.safeParse({ contentBase64: "abc" });
    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown bucket field via schema (no override allowed)", () => {
    const parsed = schema.safeParse({
      key: "k",
      contentBase64: "aGk=",
      bucket: "other",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects keys containing path traversal", async () => {
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"x"' });
    try {
      await tool.handler({ key: "../../etc/passwd", contentBase64: "aGk=" }, ctx);
      fail("expected INVALID_PARAMS");
    } catch (err) {
      expect(isAppError(err)).toBe(true);
      if (isAppError(err)) expect(err.code).toBe("INVALID_PARAMS");
    }
  });

  it("rejects oversized payloads", async () => {
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"x"' });
    // 11 MiB of base64 decodes to ~8.25 MiB? Build > 10 MiB decoded buffer.
    const big = Buffer.alloc(11 * 1024 * 1024).toString("base64");
    try {
      await tool.handler({ key: "k", contentBase64: big }, ctx);
      fail("expected PAYLOAD_TOO_LARGE");
    } catch (err) {
      expect(isAppError(err)).toBe(true);
      if (isAppError(err)) expect(err.code).toBe("PAYLOAD_TOO_LARGE");
    }
  });

  it("throws S3_UPLOAD_FAILED with retryable:true when S3 errors", async () => {
    s3Mock.on(PutObjectCommand).rejects(new Error("network down"));
    try {
      await tool.handler({ key: "k", contentBase64: "aGk=" }, ctx);
      fail("expected throw");
    } catch (err) {
      expect(isAppError(err)).toBe(true);
      if (isAppError(err)) {
        expect(err.code).toBe("S3_UPLOAD_FAILED");
        expect(err.retryable).toBe(true);
      }
    }
  });
});
