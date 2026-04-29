/**
 * 用正確簽章 POST 一個假 LINE webhook 到 channel 的 /webhook endpoint。
 *
 * 用法：
 *   LINE_CHANNEL_SECRET=... bun run tests/e2e/send-webhook.ts \
 *     --user U... --text "hi" [--port 8788] [--reply-token rep-1] [--event-id ev-1]
 */

import { computeSignature } from "../../src/line/verify.ts";

interface Args {
  user: string;
  text: string;
  port: number;
  replyToken: string;
  eventId: string;
  type: string;
  sourceType: string;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (flag: string, fallback?: string) => {
    const i = a.indexOf(flag);
    return i >= 0 ? (a[i + 1] ?? fallback ?? "") : (fallback ?? "");
  };
  return {
    user: get("--user", "U" + "a".repeat(32)),
    text: get("--text", "hello"),
    port: Number.parseInt(get("--port", "8788"), 10),
    replyToken: get("--reply-token", `rep-${Date.now()}`),
    eventId: get("--event-id", `ev-${Date.now()}`),
    type: get("--type", "message"),
    sourceType: get("--source-type", "user"),
  };
}

async function main() {
  const args = parseArgs();
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret) {
    process.stderr.write("LINE_CHANNEL_SECRET is required\n");
    process.exit(2);
  }

  const body = {
    destination: "Ufakebot00000000000000000000000000",
    events: [
      {
        type: args.type,
        webhookEventId: args.eventId,
        timestamp: Date.now(),
        source: { type: args.sourceType, userId: args.user },
        replyToken: args.replyToken,
        message: args.type === "message" ? { id: `m-${Date.now()}`, type: "text", text: args.text } : undefined,
      },
    ],
  };

  const raw = JSON.stringify(body);
  const sig = computeSignature(raw, secret);
  const url = `http://localhost:${args.port}/webhook`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-line-signature": sig,
      "content-type": "application/json",
    },
    body: raw,
  });
  const text = await res.text().catch(() => "");
  process.stdout.write(JSON.stringify({ status: res.status, body: text }) + "\n");
  process.exit(res.ok ? 0 : 1);
}

void main();
