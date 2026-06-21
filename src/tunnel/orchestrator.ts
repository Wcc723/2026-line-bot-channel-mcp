import { log } from "@/util/log.ts";

export interface TunnelStatus {
  url: string | null;
  /** channel 不再自管 tunnel，狀態恆為 external（使用者自管） */
  state: "external";
  port: number;
  message: string;
}

export interface TunnelController {
  status(): TunnelStatus;
  /** 註冊 URL 回呼。URL 由 LINE_PUBLIC_URL 提供，固定不變 */
  onUrl(cb: (url: string) => void): () => void;
}

interface StartOpts {
  port: number;
  /** 使用者自管的固定公開 URL（LINE_PUBLIC_URL）。指向使用者常駐的 cloudflared tunnel */
  publicUrl?: string;
}

/**
 * Channel 不再自動 spawn cloudflared——過去 quick/named 模式由 channel 代管
 * cloudflared 子進程，但子進程的連線穩定度與 channel lifecycle 綁在一起，
 * 容易在 session 重啟時斷線。
 *
 * 現在 tunnel 完全由使用者自管（建議：常駐的 `cloudflared` named tunnel，
 * 例如 `cloudflared service install` 或 launchd），與 channel 解耦。
 * Channel 只 listen 本機 port；對外的公開 URL 由 LINE_PUBLIC_URL 提供。
 */
export function startTunnel(opts: StartOpts): TunnelController {
  const url = opts.publicUrl ?? null;
  const subscribers = new Set<(url: string) => void>();

  if (url) {
    log.info(`tunnel: external mode，公開 URL = ${url}（請確認常駐 tunnel 已轉發到 localhost:${opts.port}）`);
  } else {
    log.warn(
      "tunnel: LINE_PUBLIC_URL 未設定——channel 只 listen port。" +
        "請自行起一條常駐 tunnel（建議 cloudflared named tunnel），" +
        "在 .env 設 LINE_PUBLIC_URL，並把 LINE webhook 設成 <LINE_PUBLIC_URL>/webhook。",
    );
  }

  return {
    status: () => ({
      url,
      state: "external",
      port: opts.port,
      message: url
        ? "tunnel 由使用者自管（建議常駐 cloudflared named tunnel）；channel 只 listen port"
        : "LINE_PUBLIC_URL 未設定；請設好固定 tunnel URL 後重啟 channel",
    }),
    onUrl: (cb) => {
      subscribers.add(cb);
      if (url) cb(url);
      return () => subscribers.delete(cb);
    },
  };
}
