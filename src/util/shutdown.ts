import { log } from "@/util/log.ts";

type Closer = () => Promise<void> | void;

export class ShutdownRegistry {
  private readonly closers: { name: string; fn: Closer }[] = [];
  private closing = false;

  add(name: string, fn: Closer): void {
    this.closers.push({ name, fn });
  }

  async runAll(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const { name, fn } of this.closers.reverse()) {
      try {
        await fn();
        log.debug(`shutdown: ${name} closed`);
      } catch (err) {
        log.warn(`shutdown: ${name} close error`, { err: String(err) });
      }
    }
  }

  install(): void {
    const handler = (signal: string) => {
      log.info(`shutdown: received ${signal}`);
      void this.runAll().then(() => process.exit(0));
    };
    process.on("SIGINT", () => handler("SIGINT"));
    process.on("SIGTERM", () => handler("SIGTERM"));
  }
}
