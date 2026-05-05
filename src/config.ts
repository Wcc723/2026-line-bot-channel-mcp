import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, mkdirSync } from "node:fs";

export type TunnelMode = "quick" | "named" | "external";

export interface LineConfig {
  channelAccessToken: string;
  channelSecret: string;
  webhookPort: number;
  publicUrl?: string;
  tunnelMode: TunnelMode;
  /** named mode 下若設定，channel 啟動時自動 spawn `cloudflared tunnel run <name>` */
  tunnelName?: string;
  apiBase?: string;
  stateDir: string;
  /**
   * PID file 路徑：用來在啟動時偵測並清掉前次孤兒 instance。
   * - undefined（預設）：用 `<stateDir>/server.pid`
   * - 具體路徑：覆寫
   * - null：完全停用（LINE_PID_FILE=off）
   */
  pidFilePath: string | null;
}

const DEFAULT_PORT = 8788;

export function getStateDir(): string {
  const override = process.env.LINE_STATE_DIR;
  if (override && override.length > 0) return override;
  return join(homedir(), ".claude", "channels", "line");
}

export function ensureStateDir(dir: string = getStateDir()): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadEnvFile(stateDir: string): Record<string, string> {
  const envPath = join(stateDir, ".env");
  if (!existsSync(envPath)) return {};
  return parseDotenv(readFileSync(envPath, "utf8"));
}

function pick(env: Record<string, string>, key: string): string | undefined {
  return process.env[key] ?? env[key];
}

export function loadConfig(): LineConfig {
  const stateDir = ensureStateDir();
  const fileEnv = loadEnvFile(stateDir);

  const channelAccessToken = pick(fileEnv, "LINE_CHANNEL_ACCESS_TOKEN") ?? "";
  const channelSecret = pick(fileEnv, "LINE_CHANNEL_SECRET") ?? "";
  const portRaw = pick(fileEnv, "LINE_WEBHOOK_PORT");
  const port = portRaw ? Number.parseInt(portRaw, 10) : DEFAULT_PORT;
  const publicUrl = pick(fileEnv, "LINE_PUBLIC_URL");
  const tunnelModeRaw = (pick(fileEnv, "LINE_TUNNEL_MODE") ?? "quick").toLowerCase();
  const tunnelMode: TunnelMode =
    tunnelModeRaw === "named" || tunnelModeRaw === "external" ? tunnelModeRaw : "quick";
  const tunnelNameRaw = pick(fileEnv, "LINE_TUNNEL_NAME");
  const tunnelName = tunnelNameRaw && tunnelNameRaw.length > 0 ? tunnelNameRaw : undefined;
  const apiBase = pick(fileEnv, "LINE_API_BASE");

  const pidFileRaw = pick(fileEnv, "LINE_PID_FILE");
  let pidFilePath: string | null;
  if (pidFileRaw === "off") {
    pidFilePath = null;
  } else if (pidFileRaw && pidFileRaw.length > 0) {
    pidFilePath = pidFileRaw;
  } else {
    pidFilePath = join(stateDir, "server.pid");
  }

  return {
    channelAccessToken,
    channelSecret,
    webhookPort: Number.isFinite(port) ? port : DEFAULT_PORT,
    publicUrl,
    tunnelMode,
    tunnelName,
    apiBase,
    stateDir,
    pidFilePath,
  };
}

export function envFilePath(stateDir: string = getStateDir()): string {
  return join(stateDir, ".env");
}

export function accessFilePath(stateDir: string = getStateDir()): string {
  return join(stateDir, "access.json");
}

export function maskToken(token: string): string {
  if (!token) return "";
  if (token.length <= 8) return "***";
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}
