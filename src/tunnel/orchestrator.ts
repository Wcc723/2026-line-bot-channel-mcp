import { spawn, type ChildProcess } from "node:child_process";
import { log } from "@/util/log.ts";
import type { TunnelMode } from "@/config.ts";

export interface TunnelStatus {
  mode: TunnelMode;
  url: string | null;
  state: "starting" | "running" | "restarting" | "stopped" | "error" | "external";
  port: number;
  message?: string;
}

export interface TunnelController {
  status(): TunnelStatus;
  restart(): Promise<void>;
  stop(): Promise<void>;
  /** 註冊 URL 變動回呼（quick mode 重啟時 URL 會變） */
  onUrl(cb: (url: string) => void): () => void;
}

interface StartOpts {
  mode: TunnelMode;
  port: number;
  publicUrl?: string;
}

const TRYCLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const RESTART_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];

export function startTunnel(opts: StartOpts): TunnelController {
  if (opts.mode === "external" || opts.mode === "named") {
    return externalController(opts);
  }
  return quickController(opts);
}

function externalController(opts: StartOpts): TunnelController {
  const url = opts.publicUrl ?? null;
  const subscribers = new Set<(url: string) => void>();
  if (url) for (const cb of subscribers) cb(url);
  return {
    status: () => ({
      mode: opts.mode,
      url,
      state: "external",
      port: opts.port,
      message:
        opts.mode === "named"
          ? "named mode: 使用者自管 cloudflared named tunnel；channel 只 listen port"
          : "external mode: 使用者自管 tunnel（ngrok 等）；channel 只 listen port",
    }),
    restart: async () => {
      log.warn("tunnel: restart noop in external/named mode");
    },
    stop: async () => {},
    onUrl: (cb) => {
      subscribers.add(cb);
      if (url) cb(url);
      return () => subscribers.delete(cb);
    },
  };
}

function quickController(opts: StartOpts): TunnelController {
  let proc: ChildProcess | null = null;
  let state: TunnelStatus["state"] = "starting";
  let url: string | null = null;
  let restartAttempt = 0;
  let stopRequested = false;
  const subscribers = new Set<(url: string) => void>();
  const updateUrl = (next: string) => {
    if (next === url) return;
    url = next;
    for (const cb of subscribers) {
      try {
        cb(next);
      } catch (err) {
        log.warn("tunnel: subscriber error", { err: String(err) });
      }
    }
  };

  const spawnOnce = () => {
    state = restartAttempt === 0 ? "starting" : "restarting";
    log.info("tunnel: spawning cloudflared quick tunnel", { port: opts.port, attempt: restartAttempt });
    const child = spawn(
      "cloudflared",
      ["tunnel", "--url", `http://localhost:${opts.port}`, "--no-autoupdate", "--metrics", "127.0.0.1:0"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    proc = child;

    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const match = text.match(TRYCLOUDFLARE_RE);
      if (match && match[0]) {
        state = "running";
        restartAttempt = 0;
        updateUrl(match[0]);
        log.info(`tunnel: ready ${match[0]}/webhook`);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      state = "error";
      log.error("tunnel: spawn error", { err: String(err) });
      scheduleRestart();
    });
    child.on("exit", (code, signal) => {
      log.warn("tunnel: cloudflared exited", { code, signal });
      proc = null;
      url = null;
      if (!stopRequested) scheduleRestart();
      else state = "stopped";
    });
  };

  const scheduleRestart = () => {
    if (stopRequested) return;
    if (restartAttempt >= RESTART_DELAYS_MS.length) {
      state = "error";
      log.error("tunnel: giving up after max restart attempts");
      return;
    }
    const delay = RESTART_DELAYS_MS[restartAttempt] ?? 16_000;
    restartAttempt += 1;
    state = "restarting";
    setTimeout(() => {
      if (!stopRequested) spawnOnce();
    }, delay);
  };

  spawnOnce();

  return {
    status: () => ({
      mode: "quick",
      url,
      state,
      port: opts.port,
      message: url ? undefined : "等待 cloudflared 公布 URL…",
    }),
    restart: async () => {
      restartAttempt = 0;
      if (proc) {
        proc.kill("SIGTERM");
        // exit handler 會 scheduleRestart
      } else {
        spawnOnce();
      }
    },
    stop: async () => {
      stopRequested = true;
      if (proc) proc.kill("SIGTERM");
      proc = null;
      state = "stopped";
    },
    onUrl: (cb) => {
      subscribers.add(cb);
      if (url) cb(url);
      return () => subscribers.delete(cb);
    },
  };
}
