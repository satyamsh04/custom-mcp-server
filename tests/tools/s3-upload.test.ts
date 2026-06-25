import { mockClient } from "aws-sdk-client-mock";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import tool, { schema } from "../../src/tools/s3-upload.js";
import type { AuthContext } from "../../src/types.js";
import { isAppError } from "../../src/errors.js";

const s3Mock = mockClient(S3Client);

const ctx: AuthContext = { subject: "user-1", scopes: [], raw: {} };

beforeEach(() => {
  s3Mock.reset();
  process.env.AWS_REGION = "us-east-1";
  process.env.S3_BUCKET_NAME = "annotation-artifacts";
  process.env.DYNAMO_TABLE_NAME = "annotation-records";
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
  process.env.SLACK_DEFAULT_CHANNEL = "#annotations";
  process.env.OAUTH_ISSUER = "https://auth.example.com/";
  process.env.OAUTH_AUDIENCE = "custom-mcp-server";
  process.env.JWKS_URI = "https://auth.example.com/jwks.json";
});

describe("s3_upload", () => {
  it("uploads and returns key & etag", async () => {
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"abc123"' });
    const res = await tool.handler(
      { key: "path/file.png", contentBase64: Buffer.from("hi").toString("base64") },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0]!.text);
    expect(payload.key).toBe("path/file.png");
    expect(payload.etag).toBe('"abc123"');
    expect(payload.bucket).toBe("annotation-artifacts");
  });

  it("rejects invalid input via schema (missing key)", () => {
    const parsed = schema.safeParse({ contentBase64: "abc" });
    expect(parsed.success).toBe(false);
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

  it("uses the override bucket when provided", async () => {
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"x"' });
    const res = await tool.handler(
      { key: "k", contentBase64: "aGk=", bucket: "other-bucket" },
      ctx,
    );
    const payload = JSON.parse(res.content[0]!.text);
    expect(payload.bucket).toBe("other-bucket");
    const calls = s3Mock.commandCalls(PutObjectCommand);
    expect(calls[0]!.args[0].input.Bucket).toBe("other-bucket");
  });
});
