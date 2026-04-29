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
