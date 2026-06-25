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
  it("writes the merged item and returns written:true", async () => {
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
    });
  });

  it("adds a condition when overwrite:false and maps conflict", async () => {
    const err = new Error("exists");
    err.name = "ConditionalCheckFailedException";
    ddbMock.on(PutCommand).rejects(err);
    try {
      await tool.handler(
        { id: "t1", attributes: { a: 1 }, overwrite: false },
        ctx,
      );
      fail("expected conflict");
    } catch (e) {
      expect(isAppError(e)).toBe(true);
      if (isAppError(e)) {
        expect(e.code).toBe("DYNAMO_CONFLICT");
        expect(e.retryable).toBe(false);
      }
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
