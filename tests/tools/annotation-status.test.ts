import { jest } from "@jest/globals";
import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { AuthContext } from "../../src/types.js";
import { isAppError } from "../../src/errors.js";
import { setTestEnv } from "../helpers/env.js";

const postMessage =
  jest.fn<(args: Record<string, unknown>) => Promise<unknown>>();

jest.unstable_mockModule("../../src/clients/slack-client.js", () => ({
  getSlackClient: () => ({ chat: { postMessage } }),
}));

const { default: tool } = await import("../../src/tools/annotation-status.js");

const ddbMock = mockClient(DynamoDBDocumentClient);
// Caller owns the records and may read + write annotations.
const ctx: AuthContext = {
  subject: "user-1",
  scopes: ["annotation:read", "annotation:write"],
  raw: {},
};
const ownedItem = { id: "t1", status: "pending", owner: "user-1" };

beforeEach(() => {
  ddbMock.reset();
  postMessage.mockReset();
  postMessage.mockResolvedValue({ ok: true, ts: "1" });
  setTestEnv();
});

describe("annotation_status", () => {
  it("declares the annotation:read scope", () => {
    expect(tool.requiredScopes).toEqual(["annotation:read"]);
  });

  it("reads status without updating", async () => {
    ddbMock.on(GetCommand).resolves({ Item: ownedItem });
    const res = await tool.handler({ taskId: "t1" }, ctx);
    const payload = JSON.parse(res.content[0]!.text);
    expect(payload).toEqual({ taskId: "t1", status: "pending" });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("updates status (conditioned on ownership) and returns updatedAt", async () => {
    ddbMock.on(GetCommand).resolves({ Item: ownedItem });
    ddbMock.on(UpdateCommand).resolves({});
    const res = await tool.handler({ taskId: "t1", newStatus: "completed" }, ctx);
    const payload = JSON.parse(res.content[0]!.text);
    expect(payload.status).toBe("completed");
    expect(typeof payload.updatedAt).toBe("string");
    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls[0]!.args[0].input.ExpressionAttributeValues![":s"]).toBe(
      "completed",
    );
    expect(calls[0]!.args[0].input.ConditionExpression).toBe("#owner = :owner");
  });

  it("rejects an update without the annotation:write scope", async () => {
    ddbMock.on(GetCommand).resolves({ Item: ownedItem });
    const readOnly: AuthContext = {
      subject: "user-1",
      scopes: ["annotation:read"],
      raw: {},
    };
    try {
      await tool.handler({ taskId: "t1", newStatus: "completed" }, readOnly);
      fail("expected FORBIDDEN");
    } catch (err) {
      expect(isAppError(err)).toBe(true);
      if (isAppError(err)) expect(err.code).toBe("FORBIDDEN");
    }
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("throws ANNOTATION_NOT_FOUND when missing", async () => {
    ddbMock.on(GetCommand).resolves({});
    await expect(tool.handler({ taskId: "missing" }, ctx)).rejects.toMatchObject(
      { code: "ANNOTATION_NOT_FOUND" },
    );
  });

  it("throws ANNOTATION_NOT_FOUND when owned by another principal", async () => {
    ddbMock
      .on(GetCommand)
      .resolves({ Item: { id: "t1", status: "pending", owner: "other" } });
    await expect(tool.handler({ taskId: "t1" }, ctx)).rejects.toMatchObject({
      code: "ANNOTATION_NOT_FOUND",
    });
  });

  it("posts to Slack when notify:true", async () => {
    ddbMock.on(GetCommand).resolves({ Item: ownedItem });
    await tool.handler({ taskId: "t1", notify: true }, ctx);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("does not notify by default", async () => {
    ddbMock.on(GetCommand).resolves({ Item: ownedItem });
    await tool.handler({ taskId: "t1" }, ctx);
    expect(postMessage).not.toHaveBeenCalled();
  });
});
