type Level = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const envLevel = (process.env.LINE_LOG_LEVEL ?? "info").toLowerCase() as Level;
const minRank = LEVEL_RANK[envLevel] ?? LEVEL_RANK.info;

function emit(level: Level, msg: string, extra?: unknown) {
  if (LEVEL_RANK[level] < minRank) return;
  const prefix = `[line:${level}]`;
  const time = new Date().toISOString();
  if (extra !== undefined) {
    process.stderr.write(`${time} ${prefix} ${msg} ${safeStringify(extra)}\n`);
  } else {
    process.stderr.write(`${time} ${prefix} ${msg}\n`);
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
