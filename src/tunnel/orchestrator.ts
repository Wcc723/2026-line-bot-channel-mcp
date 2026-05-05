import { spawn, execSync, type ChildProcess } from "node:child_process";
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
  /** named mode 才看；設了就自動 spawn `cloudflared tunnel run <tunnelName>` */
  tunnelName?: string;
}

const TRYCLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const RESTART_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];

export function startTunnel(opts: StartOpts): TunnelController {
  if (opts.mode === "external") return externalController(opts);
  if (opts.mode === "named") {
    if (opts.tunnelName) {
      return namedAutoController({ ...opts, tunnelName: opts.tunnelName });
    }
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

function detectExistingTunnel(name: string): boolean {
  try {
    const out = execSync(`pgrep -f "cloudflared tunnel run ${name}"`, { encoding: "utf8" });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * named mode + LINE_TUNNEL_NAME：channel 啟動時自動 spawn `cloudflared tunnel run <name>`，
 * lifecycle 跟 channel 綁。已偵測到同名 tunnel 在跑就 skip（避免兩份重複連 Cloudflare）。
 * cloudflared 不在 PATH 會降級為 external（純 listen，使用者自管）。
 */
function namedAutoController(opts: StartOpts & { tunnelName: string }): TunnelController {
  let proc: ChildProcess | null = null;
  let state: TunnelStatus["state"] = "starting";
  let restartAttempt = 0;
  let stopRequested = false;
  let degraded = false;
  const url = opts.publicUrl ?? null;
  const subscribers = new Set<(url: string) => void>();
  const notifyUrl = () => {
    if (url && state === "running") for (const cb of subscribers) cb(url);
  };

  const spawnOnce = () => {
    if (degraded) return;
    if (detectExistingTunnel(opts.tunnelName)) {
      log.warn(`tunnel: detected existing cloudflared for "${opts.tunnelName}", skipping spawn`);
      state = "running";
      notifyUrl();
      return;
    }
    state = restartAttempt === 0 ? "starting" : "restarting";
    log.info("tunnel: spawning cloudflared tunnel run", {
      name: opts.tunnelName,
      attempt: restartAttempt,
    });
    let child: ChildProcess;
    try {
      child = spawn("cloudflared", ["tunnel", "run", opts.tunnelName], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      handleSpawnFailure(err);
      return;
    }
    proc = child;

    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      // cloudflared 啟動成功會印 "Connection registered" / "Registered tunnel connection"
      if (state !== "running" && /(Connection registered|Registered tunnel connection)/i.test(text)) {
        state = "running";
        restartAttempt = 0;
        log.info(`tunnel: ready (named: ${opts.tunnelName})`);
        notifyUrl();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => handleSpawnFailure(err));
    child.on("exit", (code, signal) => {
      log.warn("tunnel: cloudflared exited", { code, signal, name: opts.tunnelName });
      proc = null;
      if (!stopRequested && !degraded) scheduleRestart();
      else state = "stopped";
    });
  };

  const handleSpawnFailure = (err: unknown) => {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      degraded = true;
      state = "external";
      log.warn(
        "tunnel: cloudflared not in PATH — auto-spawn disabled, falling back to external (你需要自己跑 `cloudflared tunnel run`)",
      );
      return;
    }
    log.error("tunnel: spawn error", { err: String(err) });
    state = "error";
    scheduleRestart();
  };

  const scheduleRestart = () => {
    if (stopRequested || degraded) return;
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
      mode: "named",
      url,
      state,
      port: opts.port,
      message: degraded
        ? "cloudflared not in PATH — manual mode"
        : state === "running"
          ? `named tunnel "${opts.tunnelName}" running`
          : `啟動中 (${opts.tunnelName})`,
    }),
    restart: async () => {
      if (degraded) {
        log.warn("tunnel: restart noop — degraded to external");
        return;
      }
      restartAttempt = 0;
      if (proc) proc.kill("SIGTERM");
      else spawnOnce();
    },
    stop: async () => {
      stopRequested = true;
      if (proc) proc.kill("SIGTERM");
      proc = null;
      state = "stopped";
    },
    onUrl: (cb) => {
      subscribers.add(cb);
      if (url && state === "running") cb(url);
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
