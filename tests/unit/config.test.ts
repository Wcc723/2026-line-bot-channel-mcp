import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
let originalEnv: Record<string, string | undefined>;

const ENV_KEYS = [
  "LINE_STATE_DIR",
  "LINE_CHANNEL_ACCESS_TOKEN",
  "LINE_CHANNEL_SECRET",
  "LINE_WEBHOOK_PORT",
  "LINE_PUBLIC_URL",
  "LINE_TUNNEL_MODE",
  "LINE_API_BASE",
];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "line-config-"));
  originalEnv = {};
  for (const k of ENV_KEYS) {
    originalEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.LINE_STATE_DIR = tmp;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

async function freshLoad() {
  const cacheBust = `${Date.now()}-${Math.random()}`;
  const mod = await import(`../../src/config.ts?t=${cacheBust}`);
  return mod;
}

describe("loadConfig", () => {
  it("無 .env 時回預設值", async () => {
    const { loadConfig } = await freshLoad();
    const c = loadConfig();
    expect(c.channelAccessToken).toBe("");
    expect(c.channelSecret).toBe("");
    expect(c.webhookPort).toBe(8788);
    expect(c.tunnelMode).toBe("quick");
    expect(c.publicUrl).toBeUndefined();
    expect(c.stateDir).toBe(tmp);
  });

  it("從 .env 讀取設定", async () => {
    writeFileSync(
      join(tmp, ".env"),
      [
        "LINE_CHANNEL_ACCESS_TOKEN=abc123",
        'LINE_CHANNEL_SECRET="sec456"',
        "LINE_WEBHOOK_PORT=9000",
        "LINE_TUNNEL_MODE=named",
        "LINE_PUBLIC_URL=https://example.com",
        "# 註解略過",
        "",
      ].join("\n"),
    );
    const { loadConfig } = await freshLoad();
    const c = loadConfig();
    expect(c.channelAccessToken).toBe("abc123");
    expect(c.channelSecret).toBe("sec456");
    expect(c.webhookPort).toBe(9000);
    expect(c.tunnelMode).toBe("named");
    expect(c.publicUrl).toBe("https://example.com");
  });

  it("環境變數覆寫 .env", async () => {
    writeFileSync(join(tmp, ".env"), "LINE_CHANNEL_ACCESS_TOKEN=from-file\n");
    process.env.LINE_CHANNEL_ACCESS_TOKEN = "from-env";
    const { loadConfig } = await freshLoad();
    const c = loadConfig();
    expect(c.channelAccessToken).toBe("from-env");
  });

  it("非法 tunnelMode 退回 quick", async () => {
    writeFileSync(join(tmp, ".env"), "LINE_TUNNEL_MODE=foo\n");
    const { loadConfig } = await freshLoad();
    expect(loadConfig().tunnelMode).toBe("quick");
  });

  it("ensureStateDir 會建立目錄", async () => {
    const sub = join(tmp, "nested", "dir");
    process.env.LINE_STATE_DIR = sub;
    const { ensureStateDir } = await freshLoad();
    ensureStateDir();
    mkdirSync(sub, { recursive: true });
  });
});

describe("maskToken", () => {
  it("token 太短回 ***", async () => {
    const { maskToken } = await freshLoad();
    expect(maskToken("")).toBe("");
    expect(maskToken("abc")).toBe("***");
  });
  it("長 token 顯示頭尾", async () => {
    const { maskToken } = await freshLoad();
    expect(maskToken("abcdefghij")).toBe("abcd…ghij");
  });
});
