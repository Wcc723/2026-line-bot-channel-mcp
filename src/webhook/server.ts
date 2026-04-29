import { Hono } from "hono";
import { verifySignature } from "@/line/verify.ts";
import { isLikelyWebhookBody } from "@/line/events.ts";
import type { Dispatcher } from "@/webhook/dispatcher.ts";
import { log } from "@/util/log.ts";

interface AppDeps {
  /** 取當前 channel secret（可在執行期變動） */
  getSecret: () => string;
  /** 取當前 dispatcher（config reload 時可能換實例） */
  getDispatcher: () => Dispatcher;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, ts: Date.now() }));

  app.post("/webhook", async (c) => {
    const rawBuf = Buffer.from(await c.req.arrayBuffer());
    const sig = c.req.header("x-line-signature");
    const secret = deps.getSecret();

    if (!verifySignature(rawBuf, sig, secret)) {
      log.warn("webhook: bad signature", { ip: c.req.header("x-forwarded-for") ?? "?" });
      return c.json({ ok: false, error: "bad_signature" }, 401);
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBuf.toString("utf8"));
    } catch {
      return c.json({ ok: false, error: "bad_json" }, 400);
    }

    if (!isLikelyWebhookBody(body)) {
      return c.json({ ok: false, error: "bad_body" }, 400);
    }

    const events = body.events ?? [];
    if (events.length === 0) return c.json({ ok: true });

    const dispatcher = deps.getDispatcher();
    queueMicrotask(() => {
      dispatcher.handle(events).catch((err) => {
        log.error("webhook: dispatch async failed", { err: String(err) });
      });
    });

    return c.json({ ok: true });
  });

  return app;
}
