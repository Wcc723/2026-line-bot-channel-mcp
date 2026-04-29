import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { NormalizedEvent } from "@/line/events.ts";
import type { ChannelNotifier } from "@/webhook/dispatcher.ts";
import { log } from "@/util/log.ts";

/**
 * 把 channel 事件轉成 MCP notification 推給 Claude session。
 * 用 LoggingMessageNotification（method: "notifications/message"）— Claude Code 會把這類 payload 顯示在 session。
 */
export function createMcpNotifier(server: Server): ChannelNotifier {
  return {
    async notifyMessage(event: NormalizedEvent) {
      const payload = {
        channel: "line",
        kind: "message",
        userId: event.userId,
        text: event.text,
        messageType: event.messageType,
        messageId: event.messageId,
        webhookEventId: event.webhookEventId,
        timestamp: event.timestamp,
      };
      try {
        await server.sendLoggingMessage({
          level: "info",
          logger: "line-channel",
          data: payload,
        });
      } catch (err) {
        log.warn("notifier: sendLoggingMessage failed (session may be detached)", { err: String(err) });
      }
    },
    async notifySystem(level: "info" | "warning", message: string, data?: unknown) {
      try {
        await server.sendLoggingMessage({
          level,
          logger: "line-channel",
          data: { channel: "line", kind: "system", message, data },
        });
      } catch (err) {
        log.warn("notifier: sendLoggingMessage failed", { err: String(err) });
      }
    },
  };
}
