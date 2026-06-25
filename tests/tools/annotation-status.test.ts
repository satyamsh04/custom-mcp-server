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
const ctx: AuthContext = { subject: "user-1", scopes: [], raw: {} };

beforeEach(() => {
  ddbMock.reset();
  postMessage.mockReset();
  postMessage.mockResolvedValue({ ok: true, ts: "1" });
  setTestEnv();
});

describe("annotation_status", () => {
  it("reads status without updating", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { id: "t1", status: "pending" } });
    const res = await tool.handler({ taskId: "t1" }, ctx);
    const payload = JSON.parse(res.content[0]!.text);
    expect(payload).toEqual({ taskId: "t1", status: "pending" });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("updates status and returns updatedAt", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { id: "t1", status: "pending" } });
    ddbMock.on(UpdateCommand).resolves({});
    const res = await tool.handler(
      { taskId: "t1", newStatus: "completed" },
      ctx,
    );
    const payload = JSON.parse(res.content[0]!.text);
    expect(payload.status).toBe("completed");
    expect(typeof payload.updatedAt).toBe("string");
    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls[0]!.args[0].input.ExpressionAttributeValues![":s"]).toBe(
      "completed",
    );
  });

  it("throws ANNOTATION_NOT_FOUND when missing", async () => {
    ddbMock.on(GetCommand).resolves({});
    try {
      await tool.handler({ taskId: "missing" }, ctx);
      fail("expected throw");
    } catch (err) {
      expect(isAppError(err)).toBe(true);
      if (isAppError(err)) {
        expect(err.code).toBe("ANNOTATION_NOT_FOUND");
        expect(err.retryable).toBe(false);
      }
    }
  });

  it("posts to Slack when notify:true", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { id: "t1", status: "pending" } });
    await tool.handler({ taskId: "t1", notify: true }, ctx);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("does not notify by default", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { id: "t1", status: "pending" } });
    await tool.handler({ taskId: "t1" }, ctx);
    expect(postMessage).not.toHaveBeenCalled();
  });
});
