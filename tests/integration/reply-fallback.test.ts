import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { ReplyTokenStore } from "../../src/line/replyStore.ts";
import { LineClient, isReplyTokenError } from "../../src/line/client.ts";

const USER = "U" + "a".repeat(32);

interface ApiCall {
  path: string;
  body: unknown;
}

function setupMock(opts: { replyFails?: boolean } = {}): {
  base: string;
  calls: ApiCall[];
  stop: () => Promise<void>;
} {
  const calls: ApiCall[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.json().catch(() => null);
      calls.push({ path: url.pathname, body });
      if (opts.replyFails && url.pathname === "/v2/bot/message/reply") {
        return Response.json(
          { message: "Invalid reply token" },
          { status: 400 },
        );
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  return {
    base: `http://localhost:${server.port}`,
    calls,
    stop: async () => server.stop(true),
  };
}

let mock: ReturnType<typeof setupMock>;

afterEach(async () => {
  await mock?.stop();
});

describe("reply path", () => {
  it("有 token 時走 reply API", async () => {
    mock = setupMock();
    const store = new ReplyTokenStore();
    store.set(USER, "tok-1");
    const client = new LineClient("dummy", mock.base);

    // 模擬 tools.callReply 的核心邏輯
    const token = store.take(USER);
    expect(token).toBe("tok-1");
    if (token) await client.reply(token, [{ type: "text", text: "hi" }]);

    expect(mock.calls.length).toBe(1);
    expect(mock.calls[0]?.path).toBe("/v2/bot/message/reply");
  });

  it("token 過期後走 push fallback", async () => {
    mock = setupMock();
    const store = new ReplyTokenStore(1000);
    store.set(USER, "old-token", 0); // 過期時間 t=1000
    const token = store.take(USER, 5_000);
    expect(token).toBeNull();

    const client = new LineClient("dummy", mock.base);
    await client.push(USER, [{ type: "text", text: "hi" }]);
    expect(mock.calls[0]?.path).toBe("/v2/bot/message/push");
  });

  it("LINE 回 400 Invalid reply token → isReplyTokenError 偵測為 true", async () => {
    mock = setupMock({ replyFails: true });
    const client = new LineClient("dummy", mock.base);
    let caught: unknown;
    try {
      await client.reply("expired-token", [{ type: "text", text: "hi" }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(isReplyTokenError(caught)).toBe(true);
  });
});
