import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import tool from "../../src/tools/dynamo-write.js";
import type { AuthContext } from "../../src/types.js";
import { isAppError } from "../../src/errors.js";
import { setTestEnv } from "../helpers/env.js";

const ddbMock = mockClient(DynamoDBDocumentClient);
const ctx: AuthContext = { subject: "user-1", scopes: [], raw: {} };

beforeEach(() => {
  ddbMock.reset();
  setTestEnv();
});

describe("dynamo_write", () => {
  it("declares the dynamo:write scope", () => {
    expect(tool.requiredScopes).toEqual(["dynamo:write"]);
  });

  it("stamps owner, returns written:true, and conditions on ownership", async () => {
    ddbMock.on(PutCommand).resolves({});
    const res = await tool.handler(
      { id: "t1", attributes: { status: "pending", score: 5 } },
      ctx,
    );
    expect(JSON.parse(res.content[0]!.text)).toEqual({
      id: "t1",
      written: true,
    });
    const calls = ddbMock.commandCalls(PutCommand);
    expect(calls[0]!.args[0].input.Item).toEqual({
      id: "t1",
      status: "pending",
      score: 5,
      owner: "user-1",
    });
    expect(calls[0]!.args[0].input.ConditionExpression).toBe(
      "attribute_not_exists(id) OR #owner = :owner",
    );
    expect(calls[0]!.args[0].input.ExpressionAttributeValues![":owner"]).toBe(
      "user-1",
    );
  });

  it("cannot be tricked into spoofing the owner via attributes", async () => {
    ddbMock.on(PutCommand).resolves({});
    await tool.handler({ id: "t1", attributes: { owner: "attacker" } }, ctx);
    const calls = ddbMock.commandCalls(PutCommand);
    expect(calls[0]!.args[0].input.Item!.owner).toBe("user-1");
  });

  it("rejects items that exceed the size cap", async () => {
    ddbMock.on(PutCommand).resolves({});
    const big = "x".repeat(400 * 1024);
    try {
      await tool.handler({ id: "t1", attributes: { big } }, ctx);
      fail("expected PAYLOAD_TOO_LARGE");
    } catch (e) {
      expect(isAppError(e)).toBe(true);
      if (isAppError(e)) expect(e.code).toBe("PAYLOAD_TOO_LARGE");
    }
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("maps conditional failure to FORBIDDEN when overwriting", async () => {
    const err = new Error("exists");
    err.name = "ConditionalCheckFailedException";
    ddbMock.on(PutCommand).rejects(err);
    try {
      await tool.handler({ id: "t1", attributes: { a: 1 } }, ctx);
      fail("expected FORBIDDEN");
    } catch (e) {
      expect(isAppError(e)).toBe(true);
      if (isAppError(e)) {
        expect(e.code).toBe("FORBIDDEN");
        expect(e.retryable).toBe(false);
      }
    }
  });

  it("maps conditional failure to DYNAMO_CONFLICT when overwrite:false", async () => {
    const err = new Error("exists");
    err.name = "ConditionalCheckFailedException";
    ddbMock.on(PutCommand).rejects(err);
    try {
      await tool.handler(
        { id: "t1", attributes: { a: 1 }, overwrite: false },
        ctx,
      );
      fail("expected DYNAMO_CONFLICT");
    } catch (e) {
      expect(isAppError(e)).toBe(true);
      if (isAppError(e)) expect(e.code).toBe("DYNAMO_CONFLICT");
    }
    const calls = ddbMock.commandCalls(PutCommand);
    expect(calls[0]!.args[0].input.ConditionExpression).toBe(
      "attribute_not_exists(id)",
    );
  });

  it("throws DYNAMO_WRITE_FAILED retryable:true on other AWS error", async () => {
    ddbMock.on(PutCommand).rejects(new Error("throttled"));
    try {
      await tool.handler({ id: "t1", attributes: {} }, ctx);
      fail("expected throw");
    } catch (e) {
      expect(isAppError(e)).toBe(true);
      if (isAppError(e)) {
        expect(e.code).toBe("DYNAMO_WRITE_FAILED");
        expect(e.retryable).toBe(true);
      }
    }
  });
});
