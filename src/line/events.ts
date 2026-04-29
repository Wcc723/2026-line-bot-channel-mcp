export type LineRawEvent = {
  type: string;
  timestamp?: number;
  webhookEventId?: string;
  source?: { type?: string; userId?: string; groupId?: string; roomId?: string };
  replyToken?: string;
  message?: {
    id?: string;
    type?: string;
    text?: string;
    stickerId?: string;
    packageId?: string;
    contentProvider?: { type?: string };
  };
  postback?: { data?: string };
  // 其他欄位忽略
  [key: string]: unknown;
};

export type SourceKind = "user" | "group" | "room" | "unknown";

export interface NormalizedEvent {
  webhookEventId: string;
  type: string;
  sourceKind: SourceKind;
  userId?: string;
  groupId?: string;
  roomId?: string;
  replyToken?: string;
  timestamp: number;
  text?: string;
  messageType?: string;
  messageId?: string;
  raw: LineRawEvent;
}

export function normalize(raw: LineRawEvent): NormalizedEvent {
  const sourceKind: SourceKind = ((): SourceKind => {
    const t = raw.source?.type;
    if (t === "user" || t === "group" || t === "room") return t;
    return "unknown";
  })();
  return {
    webhookEventId: raw.webhookEventId ?? `${raw.timestamp ?? Date.now()}-${Math.random()}`,
    type: raw.type,
    sourceKind,
    userId: raw.source?.userId,
    groupId: raw.source?.groupId,
    roomId: raw.source?.roomId,
    replyToken: raw.replyToken,
    timestamp: raw.timestamp ?? Date.now(),
    text: raw.message?.type === "text" ? raw.message?.text : undefined,
    messageType: raw.message?.type,
    messageId: raw.message?.id,
    raw,
  };
}

export interface WebhookBody {
  destination?: string;
  events?: LineRawEvent[];
}

export function isLikelyWebhookBody(body: unknown): body is WebhookBody {
  return typeof body === "object" && body !== null && "events" in body;
}
