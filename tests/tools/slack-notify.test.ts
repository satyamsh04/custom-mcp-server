import { jest } from "@jest/globals";
import type { AuthContext } from "../../src/types.js";
import { isAppError } from "../../src/errors.js";
import { setTestEnv } from "../helpers/env.js";

const postMessage =
  jest.fn<(args: Record<string, unknown>) => Promise<unknown>>();

jest.unstable_mockModule("../../src/clients/slack-client.js", () => ({
  getSlackClient: () => ({ chat: { postMessage } }),
}));

const { default: tool, schema } = await import(
  "../../src/tools/slack-notify.js"
);

const ctx: AuthContext = { subject: "user-1", scopes: [], raw: {} };

beforeEach(() => {
  postMessage.mockReset();
  setTestEnv();
});

describe("slack_notify", () => {
  it("declares the slack:write scope", () => {
    expect(tool.requiredScopes).toEqual(["slack:write"]);
  });

  it("escapes markup and neutralizes broadcast mentions / link injection", async () => {
    postMessage.mockResolvedValue({ ok: true, ts: "1" });
    await tool.handler(
      { message: "hey @channel <javascript:alert(1)|click> & done" },
      ctx,
    );
    const args = postMessage.mock.calls[0]![0] as { text: string };
    expect(args.text).not.toContain("@channel");
    // Angle brackets are escaped (not deleted) so no Slack link can form.
    expect(args.text).not.toContain("<");
    expect(args.text).not.toContain(">");
    expect(args.text).toContain("&lt;");
    expect(args.text).toContain("&gt;");
    expect(args.text).toContain("&amp;");
  });

  it("rejects messages over the max length via schema", () => {
    const parsed = schema.safeParse({ message: "a".repeat(4001) });
    expect(parsed.success).toBe(false);
  });

  it("posts a message and returns ts", async () => {
    postMessage.mockResolvedValue({ ok: true, ts: "168.1", channel: "C1" });
    const res = await tool.handler({ message: "hi" }, ctx);
    const payload = JSON.parse(res.content[0]!.text);
    expect(payload.ts).toBe("168.1");
    expect(payload.channel).toBe("#annotations");
  });

  it("uses the default channel when omitted", async () => {
    postMessage.mockResolvedValue({ ok: true, ts: "1" });
    await tool.handler({ message: "hi" }, ctx);
    const args = postMessage.mock.calls[0]![0] as { channel: string };
    expect(args.channel).toBe("#annotations");
  });

  it("forwards thread_ts and custom channel", async () => {
    postMessage.mockResolvedValue({ ok: true, ts: "1" });
    await tool.handler(
      { message: "reply", channel: "C999", threadTs: "100.5" },
      ctx,
    );
    const args = postMessage.mock.calls[0]![0] as {
      channel: string;
      thread_ts: string;
    };
    expect(args.channel).toBe("C999");
    expect(args.thread_ts).toBe("100.5");
  });

  it("throws SLACK_NOTIFY_FAILED when ok:false", async () => {
    postMessage.mockResolvedValue({ ok: false });
    try {
      await tool.handler({ message: "hi" }, ctx);
      fail("expected throw");
    } catch (err) {
      expect(isAppError(err)).toBe(true);
      if (isAppError(err)) {
        expect(err.code).toBe("SLACK_NOTIFY_FAILED");
      }
    }
  });
});
