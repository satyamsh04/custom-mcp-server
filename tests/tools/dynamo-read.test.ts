import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import tool from "../../src/tools/dynamo-read.js";
import type { AuthContext } from "../../src/types.js";
import { isAppError } from "../../src/errors.js";
import { setTestEnv } from "../helpers/env.js";

const ddbMock = mockClient(DynamoDBDocumentClient);
const ctx: AuthContext = { subject: "user-1", scopes: [], raw: {} };

beforeEach(() => {
  ddbMock.reset();
  setTestEnv();
});

describe("dynamo_read", () => {
  it("declares the dynamo:read scope", () => {
    expect(tool.requiredScopes).toEqual(["dynamo:read"]);
  });

  it("returns the item (minus owner) when owned by the caller", async () => {
    ddbMock
      .on(GetCommand)
      .resolves({ Item: { id: "t1", status: "pending", owner: "user-1" } });
    const res = await tool.handler({ id: "t1" }, ctx);
    const payload = JSON.parse(res.content[0]!.text);
    expect(payload.id).toBe("t1");
    expect(payload.status).toBe("pending");
    expect(payload.owner).toBeUndefined();
  });

  it("returns found:false when not present", async () => {
    ddbMock.on(GetCommand).resolves({});
    const res = await tool.handler({ id: "nope" }, ctx);
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0]!.text)).toEqual({ found: false });
  });

  it("returns found:false when owned by another principal (no enumeration)", async () => {
    ddbMock
      .on(GetCommand)
      .resolves({ Item: { id: "t1", status: "pending", owner: "someone-else" } });
    const res = await tool.handler({ id: "t1" }, ctx);
    expect(JSON.parse(res.content[0]!.text)).toEqual({ found: false });
  });

  it("throws DYNAMO_READ_FAILED retryable:true on AWS error", async () => {
    ddbMock.on(GetCommand).rejects(new Error("throttled"));
    try {
      await tool.handler({ id: "t1" }, ctx);
      fail("expected throw");
    } catch (err) {
      expect(isAppError(err)).toBe(true);
      if (isAppError(err)) {
        expect(err.code).toBe("DYNAMO_READ_FAILED");
        expect(err.retryable).toBe(true);
      }
    }
  });

  it("passes consistentRead through", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { id: "t1", owner: "user-1" } });
    await tool.handler({ id: "t1", consistentRead: true }, ctx);
    const calls = ddbMock.commandCalls(GetCommand);
    expect(calls[0]!.args[0].input.ConsistentRead).toBe(true);
  });
});
