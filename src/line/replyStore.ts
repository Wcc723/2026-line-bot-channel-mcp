interface Entry {
  token: string;
  expiresAt: number;
}

export const REPLY_TOKEN_TTL_MS = 30 * 1000;

export class ReplyTokenStore {
  private readonly map = new Map<string, Entry>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly ttlMs: number = REPLY_TOKEN_TTL_MS) {}

  startGc(intervalMs: number = 5_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.purge(), intervalMs);
    if (typeof this.timer === "object" && "unref" in this.timer) {
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.map.clear();
  }

  set(userId: string, token: string, now: number = Date.now()): void {
    this.map.set(userId, { token, expiresAt: now + this.ttlMs });
  }

  /** 取出並消費 token；過期或不存在回 null */
  take(userId: string, now: number = Date.now()): string | null {
    const e = this.map.get(userId);
    if (!e) return null;
    this.map.delete(userId);
    if (e.expiresAt <= now) return null;
    return e.token;
  }

  /** 偷看但不消費 */
  peek(userId: string, now: number = Date.now()): string | null {
    const e = this.map.get(userId);
    if (!e) return null;
    if (e.expiresAt <= now) {
      this.map.delete(userId);
      return null;
    }
    return e.token;
  }

  size(): number {
    return this.map.size;
  }

  private purge(now: number = Date.now()): void {
    for (const [k, v] of this.map) {
      if (v.expiresAt <= now) this.map.delete(k);
    }
  }
}
