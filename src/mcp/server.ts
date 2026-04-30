import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { AccessStore } from "@/access.ts";
import type { LineClient } from "@/line/client.ts";
import type { ReplyTokenStore } from "@/line/replyStore.ts";
import type { TunnelController } from "@/tunnel/orchestrator.ts";
import { registerTools } from "@/mcp/tools.ts";
import { createMcpNotifier } from "@/mcp/notify.ts";
import type { ChannelNotifier } from "@/webhook/dispatcher.ts";
import { log } from "@/util/log.ts";

interface StartOpts {
  access: AccessStore;
  client: LineClient;
  replyStore: ReplyTokenStore;
  tunnel: TunnelController;
  onConfigChange?: () => void;
  /** MCP transport 關閉時呼叫（通常代表父 Claude 退出，要連動關掉 channel 避免變孤兒） */
  onTransportClose?: () => void;
}

export interface RunningMcpServer {
  server: Server;
  notifier: ChannelNotifier;
  close: () => Promise<void>;
}

export async function startMcpServer(opts: StartOpts): Promise<RunningMcpServer> {
  const server = new Server(
    {
      name: "claude-channel-line",
      version: "0.0.1",
    },
    {
      capabilities: {
        tools: {},
        logging: {},
        // 對齊官方 telegram channel：宣告 experimental claude/channel
        // Claude Code 看到這個才會把 notifications/claude/channel 注入 session
        experimental: {
          "claude/channel": {},
          "claude/channel/permission": {},
        },
      },
    },
  );

  registerTools(server, {
    access: opts.access,
    client: opts.client,
    replyStore: opts.replyStore,
    tunnel: opts.tunnel,
    onConfigChange: opts.onConfigChange,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 父 Claude 退出 → stdin EOF → transport 觸發 onclose → 連動關 channel
  // 避免 bun 變孤兒繼續占 port 8788。
  // 注意：這個 hook 在 server.connect() 之後才設，所以背景 standalone bun（stdin 一啟動就 EOF）
  // 不會觸發此 callback（transport 在那之前就已經 close 並完成內部清理，
  // 我們的回呼只在「正常運作後才斷線」這條路徑被打中）。
  if (opts.onTransportClose) {
    transport.onclose = () => {
      log.info("mcp: transport closed (parent likely gone) → triggering shutdown");
      opts.onTransportClose?.();
    };
  }

  const notifier = createMcpNotifier(server);
  log.info("mcp: server connected via stdio");

  return {
    server,
    notifier,
    close: async () => {
      try {
        await server.close();
      } catch (err) {
        log.warn("mcp: close error", { err: String(err) });
      }
    },
  };
}
