/**
 * LINE Messaging API 薄客戶端，實作必要 endpoints。
 * 不直接依賴 @line/bot-sdk 是為了：
 *   1) 控制 base URL（測試時用 LINE_API_BASE 指向 mock）
 *   2) 控制錯誤訊息格式以便 fallback 判斷
 */

export interface LineApiError {
  status: number;
  body: unknown;
}

export type Message = TextMessage | StickerMessage | ImageMessage;
export interface TextMessage {
  type: "text";
  text: string;
  quoteToken?: string;
}
export interface StickerMessage {
  type: "sticker";
  packageId: string;
  stickerId: string;
}
export interface ImageMessage {
  type: "image";
  originalContentUrl: string;
  previewImageUrl: string;
}

export interface LineProfile {
  userId: string;
  displayName: string;
  pictureUrl?: string;
  statusMessage?: string;
  language?: string;
}

const DEFAULT_BASE = "https://api.line.me";

export class LineClient {
  constructor(
    private readonly token: string,
    private readonly baseUrl: string = process.env.LINE_API_BASE ?? DEFAULT_BASE,
  ) {}

  private async post(path: string, body: unknown): Promise<void> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        parsed = await res.text().catch(() => null);
      }
      const err = new Error(`LINE API ${path} ${res.status}`) as Error & LineApiError;
      err.status = res.status;
      err.body = parsed;
      throw err;
    }
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      const err = new Error(`LINE API ${path} ${res.status}`) as Error & LineApiError;
      err.status = res.status;
      err.body = await res.text().catch(() => null);
      throw err;
    }
    return (await res.json()) as T;
  }

  reply(replyToken: string, messages: Message[]): Promise<void> {
    return this.post("/v2/bot/message/reply", { replyToken, messages });
  }

  push(to: string, messages: Message[]): Promise<void> {
    return this.post("/v2/bot/message/push", { to, messages });
  }

  /** 對 LINE message 加 emoji reaction（2024+ API） */
  react(messageId: string, emoji: string): Promise<void> {
    return this.post(`/v2/bot/message/${encodeURIComponent(messageId)}/reaction`, {
      reactionType: { type: "emoji", productId: emoji.split(":")[0] ?? "", emojiId: emoji.split(":")[1] ?? emoji },
    });
  }

  markRead(chatId: string): Promise<void> {
    return this.post("/v2/bot/message/markAsRead", { chat: { chatId } });
  }

  getProfile(userId: string): Promise<LineProfile> {
    return this.get<LineProfile>(`/v2/bot/profile/${encodeURIComponent(userId)}`);
  }

  /** 簡易 text message 工廠 */
  static text(text: string): TextMessage {
    return { type: "text", text };
  }
}

export function isReplyTokenError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as Partial<LineApiError>;
  if (err.status !== 400) return false;
  const body = err.body as { message?: string } | undefined;
  if (!body || typeof body.message !== "string") return false;
  return /reply token/i.test(body.message) || /Invalid reply token/i.test(body.message);
}
