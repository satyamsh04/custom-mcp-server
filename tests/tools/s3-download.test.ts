import { mockClient } from "aws-sdk-client-mock";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import tool from "../../src/tools/s3-download.js";
import type { AuthContext } from "../../src/types.js";
import { isAppError } from "../../src/errors.js";
import { setTestEnv } from "../helpers/env.js";

const s3Mock = mockClient(S3Client);
const ctx: AuthContext = { subject: "user-1", scopes: [], raw: {} };

beforeEach(() => {
  s3Mock.reset();
  setTestEnv();
});

describe("s3_download", () => {
  it("declares the s3:read scope", () => {
    expect(tool.requiredScopes).toEqual(["s3:read"]);
  });

  it("returns base64 of the object body from the caller's prefix", async () => {
    const data = Buffer.from("hello world");
    s3Mock.on(GetObjectCommand).resolves({
      Body: {
        transformToByteArray: async () => new Uint8Array(data),
      } as never,
      ContentType: "text/plain",
      ContentLength: data.byteLength,
    });

    const res = await tool.handler({ key: "a/b.txt" }, ctx);
    const payload = JSON.parse(res.content[0]!.text);
    expect(Buffer.from(payload.contentBase64, "base64").toString()).toBe(
      "hello world",
    );
    expect(payload.contentType).toBe("text/plain");
    expect(payload.key).toBe("user-1/a/b.txt");
    const calls = s3Mock.commandCalls(GetObjectCommand);
    expect(calls[0]!.args[0].input.Key).toBe("user-1/a/b.txt");
  });

  it("rejects objects larger than the size cap (via ContentLength)", async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: { transformToByteArray: async () => new Uint8Array() } as never,
      ContentLength: 11 * 1024 * 1024,
    });
    try {
      await tool.handler({ key: "big.bin" }, ctx);
      fail("expected PAYLOAD_TOO_LARGE");
    } catch (e) {
      expect(isAppError(e)).toBe(true);
      if (isAppError(e)) expect(e.code).toBe("PAYLOAD_TOO_LARGE");
    }
  });

  it("throws S3_DOWNLOAD_FAILED retryable:false on NoSuchKey", async () => {
    const err = new Error("missing");
    err.name = "NoSuchKey";
    s3Mock.on(GetObjectCommand).rejects(err);
    try {
      await tool.handler({ key: "missing" }, ctx);
      fail("expected throw");
    } catch (e) {
      expect(isAppError(e)).toBe(true);
      if (isAppError(e)) {
        expect(e.code).toBe("S3_DOWNLOAD_FAILED");
        expect(e.retryable).toBe(false);
      }
    }
  });
});
