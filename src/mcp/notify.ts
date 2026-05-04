import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { NormalizedEvent } from "@/line/events.ts";
import type { ChannelNotifier } from "@/webhook/dispatcher.ts";
import type { UserEntry } from "@/access.ts";
import { log } from "@/util/log.ts";

/**
 * 把 channel 事件轉成 Claude Code channel notification。
 * Claude Code 認得的 method：
 *   notifications/claude/channel                     - 一般訊息事件（會被注入到 session）
 *   notifications/claude/channel/permission_request  - 權限詢問（v1 不用）
 *   notifications/claude/channel/permission          - 權限回應（v1 不用）
 *
 * 系統等級訊息（tunnel URL、pair 通知）走 sendLoggingMessage，
 * 不會自動注入 session 但會顯示在 stderr / debug。
 */
export function createMcpNotifier(server: Server): ChannelNotifier {
  return {
    async notifyMessage(event: NormalizedEvent, entry?: UserEntry) {
      const userId = event.userId ?? "unknown";
      const displayUser = entry?.nickname ?? userId;
      const params = {
        content: event.text ?? `[${event.messageType ?? "non-text"}]`,
        meta: {
          chat_id: userId,
          user: displayUser,                // 顯示用名稱（暱稱優先，沒有則 userId）
          user_id: userId,
          ...(entry?.nickname ? { nickname: entry.nickname } : {}),
          ...(entry?.title ? { title: entry.title } : {}),
          ...(entry?.role ? { role: entry.role } : {}),
          ...(event.messageId ? { message_id: event.messageId } : {}),
          ts: new Date(event.timestamp).toISOString(),
          channel: "line",
          message_type: event.messageType,
          webhook_event_id: event.webhookEventId,
        },
      };
      try {
        await server.notification({
          method: "notifications/claude/channel",
          params,
        });
      } catch (err) {
        log.warn("notifier: channel notification failed (session may be detached)", { err: String(err) });
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
