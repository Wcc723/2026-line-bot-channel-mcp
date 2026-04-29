import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AccessStore, DmPolicy } from "@/access.ts";
import type { LineClient, Message } from "@/line/client.ts";
import { isReplyTokenError } from "@/line/client.ts";
import type { ReplyTokenStore } from "@/line/replyStore.ts";
import { envFilePath, maskToken } from "@/config.ts";
import type { TunnelController } from "@/tunnel/orchestrator.ts";
import { log } from "@/util/log.ts";

interface ToolDeps {
  access: AccessStore;
  client: LineClient;
  replyStore: ReplyTokenStore;
  tunnel: TunnelController;
  /** 用來重啟 LineClient 與 webhook secret 的 callback（configure 改值後） */
  onConfigChange?: () => void;
}

interface ReplyArgs { user_id: string; text: string }
interface PushArgs { user_id: string; text: string }
interface ReactArgs { user_id: string; message_id: string; emoji: string }
interface MarkReadArgs { user_id: string }
interface ProfileArgs { user_id: string }

const PUBLIC_TOOLS: Tool[] = [
  {
    name: "line_reply",
    description:
      "Send a text reply to a LINE user. Uses Reply API (free, requires reply token from recent webhook event). Auto-falls back to Push API if reply token is missing/expired.",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "LINE userId (U + 32 hex)" },
        text: { type: "string", description: "Plain text message body" },
      },
      required: ["user_id", "text"],
    },
  },
  {
    name: "line_push",
    description: "Send a text message via LINE Push API (counts toward monthly quota). Use when no recent reply token is available.",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string" },
        text: { type: "string" },
      },
      required: ["user_id", "text"],
    },
  },
  {
    name: "line_react",
    description: "React to a LINE message with an emoji.",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string" },
        message_id: { type: "string", description: "LINE message id (from webhook event)" },
        emoji: { type: "string", description: "LINE official emoji id (productId:emojiId), or short alias" },
      },
      required: ["user_id", "message_id", "emoji"],
    },
  },
  {
    name: "line_mark_read",
    description: "Mark recent messages from this user as read.",
    inputSchema: {
      type: "object",
      properties: { user_id: { type: "string" } },
      required: ["user_id"],
    },
  },
  {
    name: "line_get_profile",
    description: "Fetch a LINE user's display name, picture URL, and language.",
    inputSchema: {
      type: "object",
      properties: { user_id: { type: "string" } },
      required: ["user_id"],
    },
  },
];

const INTERNAL_TOOLS: Tool[] = [
  {
    name: "_access_list",
    description: "List allowlist, pending pairs, and current dm policy. Used by /line:access skill.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "_access_pair",
    description: "Redeem a 6-digit pair code, adding the originating LINE userId to the allowlist.",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
    },
  },
  {
    name: "_access_allow",
    description: "Manually add a LINE userId to the allowlist (skip pairing).",
    inputSchema: {
      type: "object",
      properties: { user_id: { type: "string" } },
      required: ["user_id"],
    },
  },
  {
    name: "_access_remove",
    description: "Remove a userId from the allowlist.",
    inputSchema: {
      type: "object",
      properties: { user_id: { type: "string" } },
      required: ["user_id"],
    },
  },
  {
    name: "_access_set_policy",
    description: "Switch DM policy: pair (default) | allowlist | disabled.",
    inputSchema: {
      type: "object",
      properties: { policy: { type: "string", enum: ["pair", "allowlist", "disabled"] } },
      required: ["policy"],
    },
  },
  {
    name: "_tunnel_status",
    description: "Get current tunnel mode, status, and webhook URL.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "_tunnel_url",
    description: "Print the current public webhook URL (for copy/paste into LINE Developers Console).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "_tunnel_restart",
    description: "Restart the cloudflared quick tunnel (only effective in quick mode). URL may change.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "_configure_show",
    description: "Show current channel configuration (token masked).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "_configure_set",
    description: "Set channel access token, channel secret, or other env. Writes to ~/.claude/channels/line/.env.",
    inputSchema: {
      type: "object",
      properties: {
        channel_access_token: { type: "string" },
        channel_secret: { type: "string" },
        webhook_port: { type: "number" },
        public_url: { type: "string" },
        tunnel_mode: { type: "string", enum: ["quick", "named", "external"] },
      },
    },
  },
];

function asResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function asJson(obj: unknown) {
  return asResult(JSON.stringify(obj, null, 2));
}

export function registerTools(server: Server, deps: ToolDeps): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...PUBLIC_TOOLS, ...INTERNAL_TOOLS],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      switch (name) {
        case "line_reply":
          return await callReply(deps, args as unknown as ReplyArgs);
        case "line_push":
          return await callPush(deps, args as unknown as PushArgs);
        case "line_react":
          return await callReact(deps, args as unknown as ReactArgs);
        case "line_mark_read":
          return await callMarkRead(deps, args as unknown as MarkReadArgs);
        case "line_get_profile":
          return await callGetProfile(deps, args as unknown as ProfileArgs);
        case "_access_list":
          return asJson(deps.access.snapshot());
        case "_access_pair":
          return callAccessPair(deps, args as { code?: string });
        case "_access_allow": {
          const userId = String((args as { user_id?: string }).user_id ?? "");
          deps.access.allow(userId);
          return asResult(`✅ ${userId} 已加入白名單。`);
        }
        case "_access_remove": {
          const userId = String((args as { user_id?: string }).user_id ?? "");
          const ok = deps.access.remove(userId);
          return asResult(ok ? `🗑 ${userId} 已自白名單移除。` : `(找不到此 userId)`);
        }
        case "_access_set_policy": {
          const p = String((args as { policy?: string }).policy ?? "pair") as DmPolicy;
          if (p !== "pair" && p !== "allowlist" && p !== "disabled") {
            return asResult(`policy 必須是 pair / allowlist / disabled，收到：${p}`);
          }
          deps.access.setPolicy(p);
          return asResult(`✅ DM policy = ${p}`);
        }
        case "_tunnel_status":
          return asJson(deps.tunnel.status());
        case "_tunnel_url": {
          const url = deps.tunnel.status().url;
          return asResult(url ? `${url}/webhook` : "(尚無 URL，可能 tunnel 未啟動或仍在初始化)");
        }
        case "_tunnel_restart":
          await deps.tunnel.restart();
          return asResult("已要求 tunnel 重啟。");
        case "_configure_show":
          return asJson(callConfigureShow(deps));
        case "_configure_set":
          return callConfigureSet(
            deps,
            args as {
              channel_access_token?: string;
              channel_secret?: string;
              webhook_port?: number;
              public_url?: string;
              tunnel_mode?: string;
            },
          );
        default:
          return asResult(`unknown tool: ${name}`);
      }
    } catch (err) {
      log.error("tool error", { name, err: String(err) });
      return { content: [{ type: "text" as const, text: `tool error: ${String(err)}` }], isError: true };
    }
  });
}

async function callReply(deps: ToolDeps, args: ReplyArgs) {
  const userId = String(args.user_id ?? "");
  const text = String(args.text ?? "");
  if (!userId || !text) return asResult("user_id 與 text 必填");
  const token = deps.replyStore.take(userId);
  const messages: Message[] = [{ type: "text", text }];
  if (token) {
    try {
      await deps.client.reply(token, messages);
      return asResult(`✅ replied to ${userId}`);
    } catch (err) {
      if (!isReplyTokenError(err)) {
        log.warn("reply failed (non-token error)", { err: String(err) });
        return asResult(`❌ reply failed: ${String(err)}`);
      }
      log.info("reply token rejected, falling back to push");
    }
  }
  await deps.client.push(userId, messages);
  return asResult(`📤 pushed to ${userId} (${token ? "token expired/invalid → fallback" : "no token cached"})`);
}

async function callPush(deps: ToolDeps, args: PushArgs) {
  const userId = String(args.user_id ?? "");
  const text = String(args.text ?? "");
  if (!userId || !text) return asResult("user_id 與 text 必填");
  await deps.client.push(userId, [{ type: "text", text }]);
  return asResult(`📤 pushed to ${userId}`);
}

async function callReact(deps: ToolDeps, args: ReactArgs) {
  await deps.client.react(args.message_id, args.emoji);
  return asResult(`✅ reacted ${args.emoji} on ${args.message_id}`);
}

async function callMarkRead(deps: ToolDeps, args: MarkReadArgs) {
  await deps.client.markRead(args.user_id);
  return asResult(`✅ marked read for ${args.user_id}`);
}

async function callGetProfile(deps: ToolDeps, args: ProfileArgs) {
  const profile = await deps.client.getProfile(args.user_id);
  return asJson(profile);
}

function callAccessPair(deps: ToolDeps, args: { code?: string }) {
  const code = String(args.code ?? "").trim();
  if (!/^\d{6}$/.test(code)) return asResult("code 必須是 6 位數字");
  const result = deps.access.redeemPairCode(code);
  if (result.ok) return asResult(`✅ 配對成功，${result.userId} 已加入白名單。`);
  if (result.reason === "code_expired") return asResult("❌ code 已過期（10 分鐘 TTL）。請使用者再傳一次訊息產生新 code。");
  return asResult("❌ 找不到此 code。請確認輸入正確且未被兌換。");
}

function callConfigureShow(deps: ToolDeps) {
  const path = envFilePath();
  if (!existsSync(path)) {
    return { configured: false, envPath: path };
  }
  const content = readFileSync(path, "utf8");
  const map: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) map[m[1] ?? ""] = m[2] ?? "";
  }
  return {
    configured: true,
    envPath: path,
    LINE_CHANNEL_ACCESS_TOKEN: maskToken(map.LINE_CHANNEL_ACCESS_TOKEN ?? ""),
    LINE_CHANNEL_SECRET: maskToken(map.LINE_CHANNEL_SECRET ?? ""),
    LINE_WEBHOOK_PORT: map.LINE_WEBHOOK_PORT ?? "(default 8788)",
    LINE_TUNNEL_MODE: map.LINE_TUNNEL_MODE ?? "(default quick)",
    LINE_PUBLIC_URL: map.LINE_PUBLIC_URL ?? "(unset)",
  };
}

function callConfigureSet(
  deps: ToolDeps,
  args: {
    channel_access_token?: string;
    channel_secret?: string;
    webhook_port?: number;
    public_url?: string;
    tunnel_mode?: string;
  },
) {
  const path = envFilePath();
  mkdirSync(dirname(path), { recursive: true });
  const existing: Record<string, string> = {};
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) existing[m[1] ?? ""] = m[2] ?? "";
    }
  }
  if (args.channel_access_token) existing.LINE_CHANNEL_ACCESS_TOKEN = args.channel_access_token;
  if (args.channel_secret) existing.LINE_CHANNEL_SECRET = args.channel_secret;
  if (args.webhook_port) existing.LINE_WEBHOOK_PORT = String(args.webhook_port);
  if (args.public_url) existing.LINE_PUBLIC_URL = args.public_url;
  if (args.tunnel_mode) {
    if (!["quick", "named", "external"].includes(args.tunnel_mode)) {
      return asResult(`tunnel_mode 必須是 quick / named / external`);
    }
    existing.LINE_TUNNEL_MODE = args.tunnel_mode;
  }
  const content =
    Object.entries(existing)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n";
  writeFileSync(path, content, { mode: 0o600 });
  deps.onConfigChange?.();
  return asResult(`✅ 已寫入 ${path}（chmod 600）。重啟 channel 以套用新設定。`);
}
