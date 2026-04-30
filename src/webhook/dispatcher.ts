import type { AccessStore } from "@/access.ts";
import type { LineClient } from "@/line/client.ts";
import type { ReplyTokenStore } from "@/line/replyStore.ts";
import { normalize, type LineRawEvent, type NormalizedEvent } from "@/line/events.ts";
import { log } from "@/util/log.ts";

/**
 * Notifier 介面：MCP server 實作此 interface 把事件推給 Claude session。
 * 在測試或未連線時可注入無動作版本。
 */
export interface ChannelNotifier {
  notifyMessage(event: NormalizedEvent): Promise<void> | void;
  notifySystem(level: "info" | "warning", message: string, data?: unknown): Promise<void> | void;
}

interface DispatcherDeps {
  access: AccessStore;
  client: LineClient;
  replyStore: ReplyTokenStore;
  notifier: ChannelNotifier;
  pairPromptText?: (code: string) => string;
}

const DEFAULT_PAIR_PROMPT = (code: string) =>
  `🤖 Hi! 你還沒被授權與這個 Claude Code Channel 互動。\n` +
  `請把這組配對碼貼到你的 Claude Code session：\n\n` +
  `    /line:access pair ${code}\n\n` +
  `配對碼 10 分鐘內有效。完成後再傳訊息即可。`;

const NOT_ALLOWED_MSG = "🚫 此 LINE 帳號未在 Claude Code Channel 白名單中。";

const EVENT_DEDUPE_MAX = 1024;

export class Dispatcher {
  private readonly access: AccessStore;
  private readonly client: LineClient;
  private readonly replyStore: ReplyTokenStore;
  private readonly notifier: ChannelNotifier;
  private readonly pairPrompt: (code: string) => string;
  private readonly seenEventIds = new Set<string>();
  private readonly seenOrder: string[] = [];

  constructor(deps: DispatcherDeps) {
    this.access = deps.access;
    this.client = deps.client;
    this.replyStore = deps.replyStore;
    this.notifier = deps.notifier;
    this.pairPrompt = deps.pairPromptText ?? DEFAULT_PAIR_PROMPT;
  }

  private alreadySeen(id: string): boolean {
    if (this.seenEventIds.has(id)) return true;
    this.seenEventIds.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > EVENT_DEDUPE_MAX) {
      const drop = this.seenOrder.shift();
      if (drop) this.seenEventIds.delete(drop);
    }
    return false;
  }

  async handle(rawEvents: LineRawEvent[]): Promise<void> {
    for (const raw of rawEvents) {
      const ev = normalize(raw);
      if (this.alreadySeen(ev.webhookEventId)) {
        log.debug("dispatcher: duplicate event skipped", { id: ev.webhookEventId });
        continue;
      }
      try {
        await this.handleOne(ev);
      } catch (err) {
        log.error("dispatcher: handle event failed", { id: ev.webhookEventId, err: String(err) });
      }
    }
  }

  private async handleOne(ev: NormalizedEvent): Promise<void> {
    log.info("event received", {
      type: ev.type,
      source: ev.sourceKind,
      userId: ev.userId,
      text: ev.text,
      eventId: ev.webhookEventId,
    });
    if (ev.sourceKind !== "user") {
      log.debug("dispatcher: non-user source dropped", { kind: ev.sourceKind, type: ev.type });
      return;
    }

    // 配對流程：當訊息正文是 6 位數字且該 user 是 pending pair 時，自動兌換
    if (
      ev.type === "message" &&
      ev.text &&
      /^\d{6}$/.test(ev.text.trim()) &&
      this.access.policy() === "pair" &&
      !this.access.isAllowed(ev.userId ?? "")
    ) {
      // 預留：使用者也可以在 Claude session 兌換；這裡不自動兌換以避免被搶
      // 走到正常 evaluate 流程
    }

    const decision = this.access.evaluate(ev.userId);

    switch (decision.kind) {
      case "allow": {
        if (ev.replyToken && ev.userId) {
          this.replyStore.set(ev.userId, ev.replyToken);
        }
        log.info("dispatch: allow → notifyMessage", { userId: ev.userId });
        await this.notifier.notifyMessage(ev);
        return;
      }
      case "reject": {
        if (decision.reason === "not_in_allowlist" && ev.replyToken) {
          // allowlist 模式且來自陌生人：禮貌拒絕一次（避免騷擾就不再回）
          await this.tryReplyText(ev.replyToken, NOT_ALLOWED_MSG, ev.userId);
        }
        await this.notifier.notifySystem("info", "rejected_message", {
          reason: decision.reason,
          userId: ev.userId,
          eventId: ev.webhookEventId,
        });
        return;
      }
      case "pair-prompt": {
        if (!ev.userId) return;
        const code = this.access.createPairCode(ev.userId);
        if (ev.replyToken) {
          await this.tryReplyText(ev.replyToken, this.pairPrompt(code), ev.userId);
        }
        await this.notifier.notifySystem("info", "pair_prompted", {
          userId: ev.userId,
          code,
          eventId: ev.webhookEventId,
        });
        return;
      }
      case "pair-redeem":
        // 目前不從 webhook 端兌換，只在 /line:access pair 兌換
        return;
    }
  }

  private async tryReplyText(replyToken: string, text: string, userId: string | undefined): Promise<void> {
    try {
      await this.client.reply(replyToken, [{ type: "text", text }]);
    } catch (err) {
      log.warn("dispatcher: reply failed", { err: String(err) });
      if (userId) {
        try {
          await this.client.push(userId, [{ type: "text", text }]);
        } catch (err2) {
          log.error("dispatcher: push fallback failed", { err: String(err2) });
        }
      }
    }
  }
}

export function noopNotifier(): ChannelNotifier {
  return {
    notifyMessage: () => {},
    notifySystem: () => {},
  };
}
