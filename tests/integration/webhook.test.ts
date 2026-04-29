import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessStore } from "../../src/access.ts";
import { ReplyTokenStore } from "../../src/line/replyStore.ts";
import { LineClient } from "../../src/line/client.ts";
import { Dispatcher } from "../../src/webhook/dispatcher.ts";
import { createApp } from "../../src/webhook/server.ts";
import { computeSignature } from "../../src/line/verify.ts";

const SECRET = "test-secret-123";
const USER = "U" + "a".repeat(32);

interface ApiCall {
  path: string;
  body: unknown;
}

function setupMockApi(): { base: string; calls: ApiCall[]; stop: () => Promise<void> } {
  const calls: ApiCall[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.json().catch(() => null);
      calls.push({ path: url.pathname, body });
      if (url.pathname.startsWith("/v2/bot/profile/")) {
        return Response.json({ userId: USER, displayName: "Test", pictureUrl: "" });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  return {
    base: `http://localhost:${server.port}`,
    calls,
    stop: async () => {
      server.stop(true);
    },
  };
}

interface Captured {
  messages: { type: string; text?: string }[][];
  systems: { level: string; message: string; data?: unknown }[];
}

function makeNotifier(): { notifier: ReturnType<typeof captureNotifier>; captured: Captured } {
  const captured: Captured = { messages: [], systems: [] };
  return { notifier: captureNotifier(captured), captured };
}

function captureNotifier(captured: Captured) {
  return {
    notifyMessage: (event: { text?: string; type: string }) => {
      captured.messages.push([{ type: event.type, text: event.text }]);
    },
    notifySystem: (level: "info" | "warning", message: string, data?: unknown) => {
      captured.systems.push({ level, message, data });
    },
  };
}

let tmp: string;
let accessFile: string;
let mock: ReturnType<typeof setupMockApi>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "line-wh-"));
  accessFile = join(tmp, "access.json");
  mock = setupMockApi();
});

afterEach(async () => {
  rmSync(tmp, { recursive: true, force: true });
  await mock.stop();
});

function buildApp(opts: { policy: "pair" | "allowlist" | "disabled"; allow?: string[] } = { policy: "pair" }) {
  const access = new AccessStore(accessFile);
  access.setPolicy(opts.policy);
  for (const u of opts.allow ?? []) access.allow(u);
  const replyStore = new ReplyTokenStore();
  const client = new LineClient("dummy-token", mock.base);
  const { notifier, captured } = makeNotifier();
  const dispatcher = new Dispatcher({ access, client, replyStore, notifier });
  const app = createApp({
    getSecret: () => SECRET,
    getDispatcher: () => dispatcher,
  });
  return { app, captured, replyStore, access };
}

async function postWebhook(app: ReturnType<typeof createApp>, body: object, signOverride?: string) {
  const raw = JSON.stringify(body);
  const sig = signOverride ?? computeSignature(raw, SECRET);
  return app.fetch(
    new Request("http://localhost/webhook", {
      method: "POST",
      headers: {
        "x-line-signature": sig,
        "content-type": "application/json",
      },
      body: raw,
    }),
  );
}

async function flush() {
  await new Promise((r) => setTimeout(r, 30));
}

describe("webhook signature", () => {
  it("有效簽章 + 訊息事件 → 200 + notifier 收到", async () => {
    const { app, captured, access } = buildApp({ policy: "pair", allow: [USER] });
    expect(access.isAllowed(USER)).toBe(true);
    const body = {
      events: [
        {
          type: "message",
          webhookEventId: "ev1",
          timestamp: 1,
          source: { type: "user", userId: USER },
          replyToken: "rep-1",
          message: { type: "text", id: "m1", text: "hello" },
        },
      ],
    };
    const res = await postWebhook(app, body);
    expect(res.status).toBe(200);
    await flush();
    expect(captured.messages.length).toBe(1);
    expect(captured.messages[0]?.[0]?.text).toBe("hello");
  });

  it("無 x-line-signature → 401", async () => {
    const { app } = buildApp();
    const res = await app.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: [] }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("錯誤簽章 → 401", async () => {
    const { app } = buildApp();
    const res = await postWebhook(app, { events: [] }, "invalid-sig");
    expect(res.status).toBe(401);
  });

  it("空 events（LINE Verify 按鈕）→ 200", async () => {
    const { app } = buildApp();
    const res = await postWebhook(app, { events: [] });
    expect(res.status).toBe(200);
  });

  it("eventId 重複 → 第二次被去重", async () => {
    const { app, captured } = buildApp({ policy: "pair", allow: [USER] });
    const body = {
      events: [
        {
          type: "message",
          webhookEventId: "ev-dup",
          timestamp: 1,
          source: { type: "user", userId: USER },
          replyToken: "rep-x",
          message: { type: "text", text: "hi" },
        },
      ],
    };
    await postWebhook(app, body);
    await flush();
    await postWebhook(app, body);
    await flush();
    expect(captured.messages.length).toBe(1);
  });
});

describe("dispatcher access policy", () => {
  it("pair 模式 stranger → 觸發 reply API 含 6 位 code", async () => {
    const { app, access } = buildApp({ policy: "pair" });
    const body = {
      events: [
        {
          type: "message",
          webhookEventId: "ev-stranger",
          timestamp: 1,
          source: { type: "user", userId: USER },
          replyToken: "rep-2",
          message: { type: "text", text: "hi" },
        },
      ],
    };
    await postWebhook(app, body);
    await flush();
    const replyCalls = mock.calls.filter((c) => c.path === "/v2/bot/message/reply");
    expect(replyCalls.length).toBe(1);
    const replyBody = replyCalls[0]?.body as { messages?: { text?: string }[] };
    const text = replyBody?.messages?.[0]?.text ?? "";
    expect(text).toMatch(/\d{6}/);
    expect(access.snapshot().pendingPairs).toBeDefined();
    expect(Object.keys(access.snapshot().pendingPairs).length).toBe(1);
  });

  it("allowlist 模式 stranger → 不 dispatch、回拒絕訊息", async () => {
    const { app, captured } = buildApp({ policy: "allowlist" });
    const body = {
      events: [
        {
          type: "message",
          webhookEventId: "ev-allow-stranger",
          timestamp: 1,
          source: { type: "user", userId: USER },
          replyToken: "rep-3",
          message: { type: "text", text: "hi" },
        },
      ],
    };
    await postWebhook(app, body);
    await flush();
    expect(captured.messages.length).toBe(0);
    const replyCalls = mock.calls.filter((c) => c.path === "/v2/bot/message/reply");
    expect(replyCalls.length).toBe(1);
  });

  it("disabled 模式 stranger → 完全不回也不 dispatch", async () => {
    const { app, captured } = buildApp({ policy: "disabled" });
    const body = {
      events: [
        {
          type: "message",
          webhookEventId: "ev-disabled",
          timestamp: 1,
          source: { type: "user", userId: USER },
          replyToken: "rep-4",
          message: { type: "text", text: "hi" },
        },
      ],
    };
    await postWebhook(app, body);
    await flush();
    expect(captured.messages.length).toBe(0);
    expect(mock.calls.filter((c) => c.path === "/v2/bot/message/reply").length).toBe(0);
  });

  it("group 來源訊息 → 直接丟棄", async () => {
    const { app, captured } = buildApp({ policy: "pair", allow: [USER] });
    const body = {
      events: [
        {
          type: "message",
          webhookEventId: "ev-group",
          timestamp: 1,
          source: { type: "group", groupId: "Cgroup1", userId: USER },
          replyToken: "rep-g",
          message: { type: "text", text: "hi from group" },
        },
      ],
    };
    await postWebhook(app, body);
    await flush();
    expect(captured.messages.length).toBe(0);
  });
});
