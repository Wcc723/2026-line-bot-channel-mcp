import { loadConfig } from "@/config.ts";
import { AccessStore } from "@/access.ts";
import { LineClient } from "@/line/client.ts";
import { ReplyTokenStore } from "@/line/replyStore.ts";
import { Dispatcher, noopNotifier } from "@/webhook/dispatcher.ts";
import { createApp } from "@/webhook/server.ts";
import { startMcpServer } from "@/mcp/server.ts";
import { startTunnel } from "@/tunnel/orchestrator.ts";
import { ShutdownRegistry } from "@/util/shutdown.ts";
import { log } from "@/util/log.ts";

async function main() {
  const shutdown = new ShutdownRegistry();
  shutdown.install();

  let config = loadConfig();
  const access = new AccessStore();
  const replyStore = new ReplyTokenStore();
  replyStore.startGc();
  shutdown.add("replyStore", () => replyStore.stop());

  let client = new LineClient(config.channelAccessToken, config.apiBase);

  // dispatcher 用一層 holder，config reload 時可換新的（換 client 與 notifier）
  let dispatcher = new Dispatcher({ access, client, replyStore, notifier: noopNotifier() });

  // Webhook HTTP server（Hono on Bun）
  const app = createApp({
    getSecret: () => loadConfig().channelSecret,
    getDispatcher: () => dispatcher,
  });
  const httpServer = Bun.serve({ port: config.webhookPort, fetch: app.fetch });
  log.info(`webhook: listening on http://localhost:${httpServer.port}`);
  shutdown.add("http", () => {
    httpServer.stop(true);
  });

  // Tunnel
  const tunnel = startTunnel({
    mode: config.tunnelMode,
    port: config.webhookPort,
    publicUrl: config.publicUrl,
  });
  shutdown.add("tunnel", () => tunnel.stop());

  // MCP server (stdio)
  const mcp = await startMcpServer({
    access,
    client,
    replyStore,
    tunnel,
    onConfigChange: () => {
      const next = loadConfig();
      config = next;
      client = new LineClient(next.channelAccessToken, next.apiBase);
      dispatcher = new Dispatcher({ access, client, replyStore, notifier: mcp.notifier });
      log.info("config: reloaded after _configure_set");
    },
  });
  shutdown.add("mcp", () => mcp.close());

  // 用真的 notifier 重建 dispatcher
  dispatcher = new Dispatcher({ access, client, replyStore, notifier: mcp.notifier });

  // Tunnel URL 變化時提醒
  tunnel.onUrl((url) => {
    log.info(`tunnel: webhook URL = ${url}/webhook (請貼到 LINE Developers Console)`);
    void mcp.notifier.notifySystem("info", "tunnel_url", { url: `${url}/webhook` });
  });

  if (!config.channelAccessToken || !config.channelSecret) {
    log.warn(
      "config: 尚未設定 LINE_CHANNEL_ACCESS_TOKEN 或 LINE_CHANNEL_SECRET。請在 Claude session 內執行 /line:configure。",
    );
    void mcp.notifier.notifySystem("warning", "config_missing", {
      hint: "run /line:configure to set channel access token and secret",
    });
  }

  log.info(`channel: ready (mode=${config.tunnelMode}, port=${config.webhookPort})`);
}

main().catch((err) => {
  log.error("fatal: server.ts main failed", { err: String(err) });
  process.exit(1);
});
