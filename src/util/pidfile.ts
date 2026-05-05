import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { execSync } from "node:child_process";
import { log } from "@/util/log.ts";

/** 讀取 PID file；不存在 / 解析失敗 / 內容非數字 → 回 null */
export function readPidFile(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf8").trim();
    const pid = Number.parseInt(content, 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

/** 寫入 PID 到 file（mode 0o600，目錄 0o700） */
export function writePidFile(path: string, pid: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${pid}\n`, { encoding: "utf8", mode: 0o600 });
}

/** 移除 PID file（不存在不報錯） */
export function removePidFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // 不存在或無權限 → 忽略
  }
}

/** process.kill(pid, 0) 包裝；alive 回 true，不存在或 EPERM 回 false */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM = 存在但我們沒權殺，仍視為「活著」
    if (code === "EPERM") return true;
    return false;
  }
}

/** ps -p $pid -o command= 取命令列；失敗回 null */
export function getProcessCommand(pid: number): string | null {
  try {
    const out = execSync(`ps -p ${pid} -o command=`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/** 命令列是否含所有 markers（全部都要符合，不是任一） */
export function commandMatchesSelf(command: string, markers: string[]): boolean {
  if (markers.length === 0) return true;
  return markers.every((m) => command.includes(m));
}

/** 等到 predicate 為 true 或超時，每 100ms poll 一次 */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

export type CleanupResult =
  | { cleaned: true; pid: number; method: "sigterm" | "sigkill" }
  | { cleaned: false; reason: "no_pidfile" | "stale" | "not_self" | "port_still_busy" | "skipped" };

interface CleanupOpts {
  pidFilePath: string;
  /** 命令列必須含的字串（全部都要含），用來確認是「自己」 */
  selfMarkers: string[];
  /** 回 true 表示 port 仍占用 */
  portCheck?: () => Promise<boolean>;
  /** SIGTERM 後等多久才升級 SIGKILL，預設 3000 */
  termTimeoutMs?: number;
  /** SIGKILL 後等多久確認 port 釋出，預設 1000 */
  killTimeoutMs?: number;
}

/**
 * 啟動時自動清前次 instance：
 *   - 沒 pidfile / pid 已死 → 刪檔 (cleaned=false, no_pidfile/stale)
 *   - pid 活但命令不符 selfMarkers → 不殺，刪檔 (cleaned=false, not_self)
 *   - pid 活 + 是自己 → SIGTERM → 等 termTimeoutMs → 還活著 SIGKILL → 等 port 釋出
 */
export async function cleanupPreviousInstance(opts: CleanupOpts): Promise<CleanupResult> {
  const { pidFilePath, selfMarkers, portCheck, termTimeoutMs = 3000, killTimeoutMs = 1000 } = opts;

  const pid = readPidFile(pidFilePath);
  if (pid === null) {
    return { cleaned: false, reason: "no_pidfile" };
  }

  if (!isAlive(pid)) {
    log.info(`pidfile: stale (pid ${pid} already dead), removing`);
    removePidFile(pidFilePath);
    return { cleaned: false, reason: "stale" };
  }

  const command = getProcessCommand(pid);
  if (!command || !commandMatchesSelf(command, selfMarkers)) {
    log.warn(
      `pidfile: pid ${pid} alive but command does not match self markers; not killing. command=${command ?? "(unknown)"}`,
    );
    removePidFile(pidFilePath);
    return { cleaned: false, reason: "not_self" };
  }

  log.info(`pidfile: detected previous instance pid=${pid}, sending SIGTERM`);
  let method: "sigterm" | "sigkill" = "sigterm";
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    log.warn(`pidfile: SIGTERM failed for pid ${pid}`, { err: String(err) });
  }

  const exited = await waitFor(() => !isAlive(pid), termTimeoutMs);
  if (!exited) {
    log.warn(`pidfile: pid ${pid} did not exit within ${termTimeoutMs}ms, sending SIGKILL`);
    method = "sigkill";
    try {
      process.kill(pid, "SIGKILL");
    } catch (err) {
      log.warn(`pidfile: SIGKILL failed for pid ${pid}`, { err: String(err) });
    }
    await waitFor(() => !isAlive(pid), 500);
  }

  if (portCheck) {
    const portFree = await waitFor(async () => !(await portCheck()), killTimeoutMs);
    if (!portFree) {
      log.error(`pidfile: pid ${pid} cleaned but port still busy after ${killTimeoutMs}ms`);
      removePidFile(pidFilePath);
      return { cleaned: false, reason: "port_still_busy" };
    }
  }

  removePidFile(pidFilePath);
  log.info(`pidfile: cleaned previous instance pid=${pid} (${method})`);
  return { cleaned: true, pid, method };
}
