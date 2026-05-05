import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  readPidFile,
  writePidFile,
  removePidFile,
  isAlive,
  getProcessCommand,
  commandMatchesSelf,
  cleanupPreviousInstance,
} from "../../src/util/pidfile.ts";

let tmp: string;
let pidFile: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "line-pid-"));
  pidFile = join(tmp, "server.pid");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("readPidFile / writePidFile / removePidFile", () => {
  it("write 後可 read 回相同 PID", () => {
    writePidFile(pidFile, 12345);
    expect(readPidFile(pidFile)).toBe(12345);
  });

  it("檔不存在 → null", () => {
    expect(readPidFile(pidFile)).toBeNull();
  });

  it("內容非數字 → null", () => {
    writeFileSync(pidFile, "not-a-pid\n");
    expect(readPidFile(pidFile)).toBeNull();
  });

  it("PID file 權限是 0600", () => {
    writePidFile(pidFile, 9999);
    const mode = statSync(pidFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("removePidFile 不存在不報錯", () => {
    expect(() => removePidFile(pidFile)).not.toThrow();
  });

  it("removePidFile 真的刪檔", () => {
    writePidFile(pidFile, 1);
    expect(existsSync(pidFile)).toBe(true);
    removePidFile(pidFile);
    expect(existsSync(pidFile)).toBe(false);
  });
});

describe("isAlive", () => {
  it("自己的 PID 永遠 alive", () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  it("不存在的高 PID 回 false", () => {
    // 999999 通常不會存在；POSIX max_pid 大致 4194304 但實務罕見達到
    expect(isAlive(999999)).toBe(false);
  });
});

describe("getProcessCommand", () => {
  it("自己的 PID 能拿到 command", () => {
    const cmd = getProcessCommand(process.pid);
    expect(cmd).not.toBeNull();
    expect(cmd!.length).toBeGreaterThan(0);
  });

  it("不存在的 PID 回 null", () => {
    expect(getProcessCommand(999999)).toBeNull();
  });
});

describe("commandMatchesSelf", () => {
  it("空 markers 一律 match", () => {
    expect(commandMatchesSelf("anything", [])).toBe(true);
  });

  it("所有 markers 都要含才 match", () => {
    expect(commandMatchesSelf("/usr/local/bin/bun server.ts", ["bun", "server.ts"])).toBe(true);
    expect(commandMatchesSelf("/usr/local/bin/node server.js", ["bun", "server.ts"])).toBe(false);
    expect(commandMatchesSelf("bun something-else", ["bun", "server.ts"])).toBe(false);
  });
});

describe("cleanupPreviousInstance", () => {
  it("沒 pidfile → reason: no_pidfile", async () => {
    const r = await cleanupPreviousInstance({
      pidFilePath: pidFile,
      selfMarkers: ["bun"],
    });
    expect(r).toEqual({ cleaned: false, reason: "no_pidfile" });
  });

  it("PID 已死 → 刪檔，reason: stale", async () => {
    writePidFile(pidFile, 999999);
    const r = await cleanupPreviousInstance({
      pidFilePath: pidFile,
      selfMarkers: ["bun"],
    });
    expect(r).toEqual({ cleaned: false, reason: "stale" });
    expect(existsSync(pidFile)).toBe(false);
  });

  it("PID 活但命令不符 → 不殺，刪檔，reason: not_self", async () => {
    // 用 PID 1（init/launchd）：永遠活著、命令絕不含 "bun-server-marker-xyz"
    writePidFile(pidFile, 1);
    const r = await cleanupPreviousInstance({
      pidFilePath: pidFile,
      selfMarkers: ["bun-server-marker-xyz"],
    });
    expect(r).toEqual({ cleaned: false, reason: "not_self" });
    expect(existsSync(pidFile)).toBe(false);
  });

  it("PID 活 + 命令符合 → SIGTERM 殺掉、刪檔、cleaned=true", async () => {
    // 起一個會等久的 sleep child（POSIX 上 sleep 命令穩定存在）
    const child = spawn("sleep", ["60"], { stdio: "ignore" });
    expect(child.pid).toBeDefined();
    const childPid = child.pid!;

    writePidFile(pidFile, childPid);
    const r = await cleanupPreviousInstance({
      pidFilePath: pidFile,
      selfMarkers: ["sleep"], // sleep 命令含 "sleep"
      termTimeoutMs: 2000,
    });

    expect(r.cleaned).toBe(true);
    if (r.cleaned) {
      expect(r.pid).toBe(childPid);
      expect(["sigterm", "sigkill"]).toContain(r.method);
    }
    expect(existsSync(pidFile)).toBe(false);
    // 確認 child 真的死了
    expect(isAlive(childPid)).toBe(false);
  });
});
