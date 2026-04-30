import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const envLevel = (process.env.LINE_LOG_LEVEL ?? "info").toLowerCase() as Level;
const minRank = LEVEL_RANK[envLevel] ?? LEVEL_RANK.info;

const fileTarget = (() => {
  const explicit = process.env.LINE_LOG_FILE;
  if (explicit === "off") return null;
  if (explicit && explicit.length > 0) return explicit;
  const stateDir = process.env.LINE_STATE_DIR ?? join(homedir(), ".claude", "channels", "line");
  return join(stateDir, "server.log");
})();

if (fileTarget) {
  try {
    mkdirSync(dirname(fileTarget), { recursive: true });
  } catch {
    // 失敗不影響運作，stderr 永遠在
  }
}

function emit(level: Level, msg: string, extra?: unknown) {
  if (LEVEL_RANK[level] < minRank) return;
  const prefix = `[line:${level}]`;
  const time = new Date().toISOString();
  const line =
    extra !== undefined
      ? `${time} ${prefix} ${msg} ${safeStringify(extra)}\n`
      : `${time} ${prefix} ${msg}\n`;
  process.stderr.write(line);
  if (fileTarget) {
    try {
      appendFileSync(fileTarget, line);
    } catch {
      // 無法寫檔不致命
    }
  }
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const log = {
  debug: (msg: string, extra?: unknown) => emit("debug", msg, extra),
  info: (msg: string, extra?: unknown) => emit("info", msg, extra),
  warn: (msg: string, extra?: unknown) => emit("warn", msg, extra),
  error: (msg: string, extra?: unknown) => emit("error", msg, extra),
};
