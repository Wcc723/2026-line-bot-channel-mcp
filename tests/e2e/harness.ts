/**
 * E2E harness：在 localhost:9999 起一個 mock LINE API server，
 * 把 channel 的所有對外呼叫攔到 JSON log，供 agent 驗證。
 *
 * 用法：
 *   bun run tests/e2e/harness.ts up [port=9999] [logPath=./tests/e2e/calls.log.jsonl]
 *   bun run tests/e2e/harness.ts read [logPath=./tests/e2e/calls.log.jsonl]
 *   bun run tests/e2e/harness.ts clear [logPath=./tests/e2e/calls.log.jsonl]
 */

import { writeFileSync, appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const subcommand = process.argv[2] ?? "up";
const arg1 = process.argv[3];
const arg2 = process.argv[4];

const DEFAULT_LOG = resolve(import.meta.dir ?? ".", "calls.log.jsonl");

if (subcommand === "up") {
  const port = arg1 ? Number.parseInt(arg1, 10) : 9999;
  const logPath = arg2 ?? DEFAULT_LOG;
  if (existsSync(logPath)) unlinkSync(logPath);
  writeFileSync(logPath, "");

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      for (const [k, v] of req.headers) headers[k] = v;
      let body: unknown = null;
      try {
        if (req.method !== "GET") body = await req.json();
      } catch {
        body = await req.text().catch(() => null);
      }
      const entry = {
        ts: Date.now(),
        method: req.method,
        path: url.pathname,
        body,
      };
      appendFileSync(logPath, JSON.stringify(entry) + "\n");

      // 模擬常見 endpoints
      if (url.pathname.startsWith("/v2/bot/profile/")) {
        const userId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
        return Response.json({ userId, displayName: "MockUser", pictureUrl: "" });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  process.stdout.write(`mock-line-api: http://localhost:${server.port}\n`);
  process.stdout.write(`log: ${logPath}\n`);
  process.stdout.write(`PID: ${process.pid}\n`);

  // 跑到被 SIGTERM
  process.on("SIGINT", () => {
    server.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    server.stop();
    process.exit(0);
  });
} else if (subcommand === "read") {
  const logPath = arg1 ?? DEFAULT_LOG;
  if (!existsSync(logPath)) {
    process.stdout.write("[]\n");
    process.exit(0);
  }
  const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  const calls = lines.map((l) => JSON.parse(l));
  process.stdout.write(JSON.stringify(calls, null, 2) + "\n");
} else if (subcommand === "clear") {
  const logPath = arg1 ?? DEFAULT_LOG;
  if (existsSync(logPath)) unlinkSync(logPath);
  writeFileSync(logPath, "");
  process.stdout.write("cleared\n");
} else {
  process.stderr.write(`unknown subcommand: ${subcommand}\n`);
  process.exit(2);
}
