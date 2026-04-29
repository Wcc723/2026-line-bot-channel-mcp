import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomInt } from "node:crypto";
import { accessFilePath } from "@/config.ts";

export type DmPolicy = "pair" | "allowlist" | "disabled";

export interface PendingPair {
  userId: string;
  createdAt: number;
  expiresAt: number;
}

export interface AccessState {
  dmPolicy: DmPolicy;
  allowFrom: string[];
  pendingPairs: Record<string, PendingPair>;
}

export type Decision =
  | { kind: "allow" }
  | { kind: "reject"; reason: string }
  | { kind: "pair-prompt" }
  | { kind: "pair-redeem"; code: string };

export const PAIR_CODE_TTL_MS = 10 * 60 * 1000;

const USER_ID_RE = /^U[0-9a-f]{32}$/;

const DEFAULT_STATE: AccessState = {
  dmPolicy: "pair",
  allowFrom: [],
  pendingPairs: {},
};

export class AccessStore {
  private state: AccessState;
  constructor(private readonly filePath: string = accessFilePath()) {
    this.state = AccessStore.read(this.filePath);
  }

  static read(filePath: string): AccessState {
    if (!existsSync(filePath)) return structuredClone(DEFAULT_STATE);
    try {
      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<AccessState>;
      return {
        dmPolicy: parsed.dmPolicy ?? DEFAULT_STATE.dmPolicy,
        allowFrom: Array.isArray(parsed.allowFrom) ? [...parsed.allowFrom] : [],
        pendingPairs:
          parsed.pendingPairs && typeof parsed.pendingPairs === "object"
            ? { ...parsed.pendingPairs }
            : {},
      };
    } catch {
      return structuredClone(DEFAULT_STATE);
    }
  }

  private flush(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf8");
    renameSync(tmp, this.filePath);
  }

  reload(): void {
    this.state = AccessStore.read(this.filePath);
  }

  snapshot(): AccessState {
    this.purgeExpiredPairs();
    return structuredClone(this.state);
  }

  policy(): DmPolicy {
    return this.state.dmPolicy;
  }

  setPolicy(policy: DmPolicy): void {
    this.state.dmPolicy = policy;
    this.flush();
  }

  allow(userId: string): void {
    if (!USER_ID_RE.test(userId)) {
      throw new Error(`invalid userId format: ${userId} (expect U + 32 hex)`);
    }
    if (!this.state.allowFrom.includes(userId)) {
      this.state.allowFrom.push(userId);
      this.flush();
    }
  }

  remove(userId: string): boolean {
    const before = this.state.allowFrom.length;
    this.state.allowFrom = this.state.allowFrom.filter((u) => u !== userId);
    if (this.state.allowFrom.length !== before) {
      this.flush();
      return true;
    }
    return false;
  }

  isAllowed(userId: string): boolean {
    return this.state.allowFrom.includes(userId);
  }

  private purgeExpiredPairs(): void {
    const now = Date.now();
    let dirty = false;
    for (const [code, pair] of Object.entries(this.state.pendingPairs)) {
      if (pair.expiresAt <= now) {
        delete this.state.pendingPairs[code];
        dirty = true;
      }
    }
    if (dirty) this.flush();
  }

  createPairCode(userId: string, now: number = Date.now()): string {
    if (!USER_ID_RE.test(userId)) {
      throw new Error(`invalid userId format: ${userId}`);
    }
    this.purgeExpiredPairs();
    let code = "";
    for (let i = 0; i < 10; i++) {
      const candidate = String(randomInt(0, 1_000_000)).padStart(6, "0");
      if (!this.state.pendingPairs[candidate]) {
        code = candidate;
        break;
      }
    }
    if (!code) throw new Error("failed to generate unique pair code");
    this.state.pendingPairs[code] = {
      userId,
      createdAt: now,
      expiresAt: now + PAIR_CODE_TTL_MS,
    };
    this.flush();
    return code;
  }

  redeemPairCode(code: string, now: number = Date.now()): { ok: true; userId: string } | { ok: false; reason: string } {
    // 不先 purge：才能精準回報 expired vs not_found
    const pair = this.state.pendingPairs[code];
    if (!pair) return { ok: false, reason: "code_not_found" };
    if (pair.expiresAt <= now) {
      delete this.state.pendingPairs[code];
      this.flush();
      return { ok: false, reason: "code_expired" };
    }
    delete this.state.pendingPairs[code];
    if (!this.state.allowFrom.includes(pair.userId)) {
      this.state.allowFrom.push(pair.userId);
    }
    this.flush();
    return { ok: true, userId: pair.userId };
  }

  evaluate(userId: string | undefined): Decision {
    if (!userId) return { kind: "reject", reason: "missing_user_id" };
    if (!USER_ID_RE.test(userId)) return { kind: "reject", reason: "invalid_user_id" };
    if (this.isAllowed(userId)) return { kind: "allow" };
    switch (this.state.dmPolicy) {
      case "disabled":
        return { kind: "reject", reason: "dm_disabled" };
      case "allowlist":
        return { kind: "reject", reason: "not_in_allowlist" };
      case "pair":
        return { kind: "pair-prompt" };
    }
  }
}

export function isValidUserId(userId: string): boolean {
  return USER_ID_RE.test(userId);
}
