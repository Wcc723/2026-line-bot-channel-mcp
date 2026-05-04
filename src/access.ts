import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomInt } from "node:crypto";
import { accessFilePath } from "@/config.ts";

export type DmPolicy = "pair" | "allowlist" | "disabled";
export type Role = "owner" | "member";

export interface UserEntry {
  userId: string;
  /** 暱稱：Claude 用來稱呼此使用者，例如 "Casper"、"A君" */
  nickname?: string;
  /** 稱謂：表示與使用者的關係，例如 "助教"、"老師"、"媽媽" */
  title?: string;
  role: Role;
  addedAt: number;
}

export interface PendingPair {
  userId: string;
  createdAt: number;
  expiresAt: number;
}

export interface AccessState {
  dmPolicy: DmPolicy;
  users: UserEntry[];
  pendingPairs: Record<string, PendingPair>;
}

export type Decision =
  | { kind: "allow" }
  | { kind: "reject"; reason: string }
  | { kind: "pair-prompt" }
  | { kind: "pair-redeem"; code: string };

export interface UserMetaOpts {
  nickname?: string;
  title?: string;
  role?: Role;
}

export const PAIR_CODE_TTL_MS = 10 * 60 * 1000;

const USER_ID_RE = /^U[0-9a-f]{32}$/;
const VALID_ROLES: ReadonlyArray<Role> = ["owner", "member"];

const DEFAULT_STATE: AccessState = {
  dmPolicy: "pair",
  users: [],
  pendingPairs: {},
};

function normalizeEntry(raw: unknown, fallbackAddedAt: number): UserEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<UserEntry>;
  if (typeof r.userId !== "string" || !USER_ID_RE.test(r.userId)) return null;
  const role: Role = r.role === "owner" ? "owner" : "member";
  return {
    userId: r.userId,
    role,
    addedAt: typeof r.addedAt === "number" ? r.addedAt : fallbackAddedAt,
    ...(typeof r.nickname === "string" && r.nickname.length > 0 ? { nickname: r.nickname } : {}),
    ...(typeof r.title === "string" && r.title.length > 0 ? { title: r.title } : {}),
  };
}

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
      const now = Date.now();
      const users: UserEntry[] = [];
      if (Array.isArray(parsed.users)) {
        for (const u of parsed.users) {
          const norm = normalizeEntry(u, now);
          if (norm) users.push(norm);
        }
      }
      // 不認 legacy allowFrom（v0.0.1 → v0.1.0 沒散播給別人，本機 access.json 直接手改）
      return {
        dmPolicy: parsed.dmPolicy ?? DEFAULT_STATE.dmPolicy,
        users,
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
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { encoding: "utf8", mode: 0o600 });
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

  /**
   * 加入白名單。已存在者：保留既有 entry 但合併傳入的 opts（不覆寫已設定但 opts 未提供的欄位）。
   */
  allow(userId: string, opts: UserMetaOpts = {}): UserEntry {
    if (!USER_ID_RE.test(userId)) {
      throw new Error(`invalid userId format: ${userId} (expect U + 32 hex)`);
    }
    if (opts.role !== undefined && !VALID_ROLES.includes(opts.role)) {
      throw new Error(`invalid role: ${opts.role}`);
    }
    const existing = this.state.users.find((u) => u.userId === userId);
    if (existing) {
      this.applyMetaInPlace(existing, opts);
      this.flush();
      return structuredClone(existing);
    }
    const entry: UserEntry = {
      userId,
      role: opts.role ?? "member",
      addedAt: Date.now(),
      ...(opts.nickname ? { nickname: opts.nickname } : {}),
      ...(opts.title ? { title: opts.title } : {}),
    };
    this.state.users.push(entry);
    this.flush();
    return structuredClone(entry);
  }

  setMeta(userId: string, opts: UserMetaOpts): UserEntry {
    if (!USER_ID_RE.test(userId)) {
      throw new Error(`invalid userId format: ${userId}`);
    }
    if (opts.role !== undefined && !VALID_ROLES.includes(opts.role)) {
      throw new Error(`invalid role: ${opts.role}`);
    }
    const existing = this.state.users.find((u) => u.userId === userId);
    if (!existing) {
      throw new Error(`user not in allowlist: ${userId}`);
    }
    this.applyMetaInPlace(existing, opts);
    this.flush();
    return structuredClone(existing);
  }

  private applyMetaInPlace(entry: UserEntry, opts: UserMetaOpts): void {
    if (opts.nickname !== undefined) {
      if (opts.nickname === "") delete entry.nickname;
      else entry.nickname = opts.nickname;
    }
    if (opts.title !== undefined) {
      if (opts.title === "") delete entry.title;
      else entry.title = opts.title;
    }
    if (opts.role !== undefined) {
      entry.role = opts.role;
    }
  }

  getUser(userId: string): UserEntry | undefined {
    const found = this.state.users.find((u) => u.userId === userId);
    return found ? structuredClone(found) : undefined;
  }

  remove(userId: string): boolean {
    const before = this.state.users.length;
    this.state.users = this.state.users.filter((u) => u.userId !== userId);
    if (this.state.users.length !== before) {
      this.flush();
      return true;
    }
    return false;
  }

  isAllowed(userId: string): boolean {
    return this.state.users.some((u) => u.userId === userId);
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

  redeemPairCode(
    code: string,
    optsOrNow?: UserMetaOpts | number,
    nowMaybe?: number,
  ): { ok: true; userId: string; entry: UserEntry } | { ok: false; reason: string } {
    // 兼容舊的 redeemPairCode(code, now) 簽名 + 新的 (code, opts, now?)
    let opts: UserMetaOpts = {};
    let now = Date.now();
    if (typeof optsOrNow === "number") {
      now = optsOrNow;
    } else if (optsOrNow && typeof optsOrNow === "object") {
      opts = optsOrNow;
      if (typeof nowMaybe === "number") now = nowMaybe;
    }

    const pair = this.state.pendingPairs[code];
    if (!pair) return { ok: false, reason: "code_not_found" };
    if (pair.expiresAt <= now) {
      delete this.state.pendingPairs[code];
      this.flush();
      return { ok: false, reason: "code_expired" };
    }
    delete this.state.pendingPairs[code];
    const userId = pair.userId;
    const existing = this.state.users.find((u) => u.userId === userId);
    let entry: UserEntry;
    if (existing) {
      this.applyMetaInPlace(existing, opts);
      entry = existing;
    } else {
      entry = {
        userId,
        role: opts.role ?? "member",
        addedAt: now,
        ...(opts.nickname ? { nickname: opts.nickname } : {}),
        ...(opts.title ? { title: opts.title } : {}),
      };
      this.state.users.push(entry);
    }
    this.flush();
    return { ok: true, userId, entry: structuredClone(entry) };
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

export function isValidRole(role: string): role is Role {
  return (VALID_ROLES as ReadonlyArray<string>).includes(role);
}
