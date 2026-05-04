import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessStore, PAIR_CODE_TTL_MS, isValidUserId } from "../../src/access.ts";

const VALID_USER_A = "U" + "a".repeat(32);
const VALID_USER_B = "U" + "b".repeat(32);

let tmp: string;
let file: string;
let store: AccessStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "line-access-"));
  file = join(tmp, "access.json");
  store = new AccessStore(file);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("isValidUserId", () => {
  it("接受 U + 32 hex 格式", () => {
    expect(isValidUserId(VALID_USER_A)).toBe(true);
    expect(isValidUserId("U0123456789abcdef0123456789abcdef")).toBe(true);
  });
  it("拒絕錯誤格式", () => {
    expect(isValidUserId("u" + "a".repeat(32))).toBe(false);
    expect(isValidUserId("U" + "a".repeat(31))).toBe(false);
    expect(isValidUserId("U" + "g".repeat(32))).toBe(false);
    expect(isValidUserId("")).toBe(false);
  });
});

describe("AccessStore policy", () => {
  it("預設 policy 為 pair", () => {
    expect(store.policy()).toBe("pair");
  });

  it("setPolicy 可切換並寫入檔案", () => {
    store.setPolicy("allowlist");
    expect(store.policy()).toBe("allowlist");
    expect(existsSync(file)).toBe(true);
    const written = JSON.parse(readFileSync(file, "utf8"));
    expect(written.dmPolicy).toBe("allowlist");
  });
});

describe("AccessStore evaluate", () => {
  it("缺 userId 一律 reject", () => {
    expect(store.evaluate(undefined)).toEqual({ kind: "reject", reason: "missing_user_id" });
  });

  it("格式錯誤 reject", () => {
    expect(store.evaluate("not-valid")).toEqual({ kind: "reject", reason: "invalid_user_id" });
  });

  it("已在 allowlist 永遠 allow，不論 policy", () => {
    store.allow(VALID_USER_A);
    store.setPolicy("disabled");
    expect(store.evaluate(VALID_USER_A)).toEqual({ kind: "allow" });
  });

  it("pair 模式：陌生 user 拿到 pair-prompt", () => {
    expect(store.evaluate(VALID_USER_A)).toEqual({ kind: "pair-prompt" });
  });

  it("allowlist 模式：陌生 user 被 reject", () => {
    store.setPolicy("allowlist");
    expect(store.evaluate(VALID_USER_A)).toEqual({ kind: "reject", reason: "not_in_allowlist" });
  });

  it("disabled 模式：陌生 user 被 reject", () => {
    store.setPolicy("disabled");
    expect(store.evaluate(VALID_USER_A)).toEqual({ kind: "reject", reason: "dm_disabled" });
  });
});

describe("AccessStore pair code", () => {
  it("createPairCode 回傳 6 位數字", () => {
    const code = store.createPairCode(VALID_USER_A);
    expect(code).toMatch(/^\d{6}$/);
  });

  it("createPairCode 不重複（10 個 user 都不撞）", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const userId = "U" + String(i).repeat(32).slice(0, 32).padStart(32, "f");
      codes.add(store.createPairCode(userId));
    }
    expect(codes.size).toBe(10);
  });

  it("redeem 有效 code 加入 allowlist", () => {
    const code = store.createPairCode(VALID_USER_A);
    const r = store.redeemPairCode(code);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.userId).toBe(VALID_USER_A);
      expect(r.entry.role).toBe("member");
    }
    expect(store.isAllowed(VALID_USER_A)).toBe(true);
  });

  it("redeem 帶 opts 同時設身份", () => {
    const code = store.createPairCode(VALID_USER_A);
    const r = store.redeemPairCode(code, { nickname: "Casper", role: "owner" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entry.nickname).toBe("Casper");
      expect(r.entry.role).toBe("owner");
    }
    const u = store.getUser(VALID_USER_A);
    expect(u?.nickname).toBe("Casper");
    expect(u?.role).toBe("owner");
  });

  it("redeem 不存在的 code → code_not_found", () => {
    const r = store.redeemPairCode("000000");
    expect(r).toEqual({ ok: false, reason: "code_not_found" });
  });

  it("redeem 過期 code → code_expired", () => {
    const created = Date.now() - PAIR_CODE_TTL_MS - 1000;
    const code = store.createPairCode(VALID_USER_A, created);
    const r = store.redeemPairCode(code, {}, Date.now());
    expect(r).toEqual({ ok: false, reason: "code_expired" });
  });

  it("redeem 後 code 失效，無法重複兌換", () => {
    const code = store.createPairCode(VALID_USER_A);
    const r1 = store.redeemPairCode(code);
    expect(r1.ok).toBe(true);
    const r2 = store.redeemPairCode(code);
    expect(r2).toEqual({ ok: false, reason: "code_not_found" });
  });

  it("invalid userId 不能 createPairCode", () => {
    expect(() => store.createPairCode("invalid")).toThrow();
  });
});

describe("AccessStore allow / remove", () => {
  it("remove 不存在的 user 回 false", () => {
    expect(store.remove(VALID_USER_A)).toBe(false);
  });

  it("remove 已存在 user 回 true 並寫檔", () => {
    store.allow(VALID_USER_A);
    expect(store.remove(VALID_USER_A)).toBe(true);
    expect(store.isAllowed(VALID_USER_A)).toBe(false);
  });

  it("allow 同一 userId 兩次不會重複加", () => {
    store.allow(VALID_USER_A);
    store.allow(VALID_USER_A);
    const snap = store.snapshot();
    expect(snap.users.filter((u) => u.userId === VALID_USER_A).length).toBe(1);
  });

  it("invalid userId 不能 allow", () => {
    expect(() => store.allow("nope")).toThrow();
  });

  it("allow 帶 opts 設 nickname / title / role", () => {
    const e = store.allow(VALID_USER_A, { nickname: "Casper", title: "老闆", role: "owner" });
    expect(e.nickname).toBe("Casper");
    expect(e.title).toBe("老闆");
    expect(e.role).toBe("owner");
    expect(e.addedAt).toBeGreaterThan(0);
  });

  it("allow 不帶 opts 預設 role=member、無 nickname/title", () => {
    const e = store.allow(VALID_USER_A);
    expect(e.role).toBe("member");
    expect(e.nickname).toBeUndefined();
    expect(e.title).toBeUndefined();
  });

  it("allow 第二次帶新 opts → 合併（已設的不被清掉）", () => {
    store.allow(VALID_USER_A, { nickname: "Casper" });
    const e = store.allow(VALID_USER_A, { role: "owner" });
    expect(e.nickname).toBe("Casper");
    expect(e.role).toBe("owner");
  });

  it("allow 拒絕無效 role", () => {
    expect(() => store.allow(VALID_USER_A, { role: "admin" as never })).toThrow();
  });
});

describe("AccessStore setMeta / getUser", () => {
  it("setMeta 更新已存在 user 的欄位", () => {
    store.allow(VALID_USER_A, { role: "member" });
    const e = store.setMeta(VALID_USER_A, { nickname: "A君", title: "助教" });
    expect(e.nickname).toBe("A君");
    expect(e.title).toBe("助教");
    expect(e.role).toBe("member"); // 未動
  });

  it("setMeta 傳空 nickname 會清掉", () => {
    store.allow(VALID_USER_A, { nickname: "X" });
    const e = store.setMeta(VALID_USER_A, { nickname: "" });
    expect(e.nickname).toBeUndefined();
  });

  it("setMeta 對不存在的 user → throw", () => {
    expect(() => store.setMeta(VALID_USER_A, { nickname: "A" })).toThrow(/not in allowlist/);
  });

  it("getUser 找不到回 undefined", () => {
    expect(store.getUser(VALID_USER_A)).toBeUndefined();
  });

  it("getUser 回的物件是 clone（mutate 不影響內部）", () => {
    store.allow(VALID_USER_A, { nickname: "A" });
    const e = store.getUser(VALID_USER_A);
    if (e) e.nickname = "X";
    expect(store.getUser(VALID_USER_A)?.nickname).toBe("A");
  });
});

describe("AccessStore persistence", () => {
  it("第二個 instance 能讀回前一個寫入的狀態", () => {
    store.allow(VALID_USER_A);
    store.setPolicy("allowlist");
    const second = new AccessStore(file);
    expect(second.policy()).toBe("allowlist");
    expect(second.isAllowed(VALID_USER_A)).toBe(true);
  });

  it("snapshot 不會 mutate 原 state", () => {
    store.allow(VALID_USER_A);
    const snap = store.snapshot();
    snap.users.push({ userId: VALID_USER_B, role: "member", addedAt: Date.now() });
    expect(store.isAllowed(VALID_USER_B)).toBe(false);
  });

  it("檔案不存在時用預設值", () => {
    const fresh = new AccessStore(join(tmp, "nope.json"));
    expect(fresh.policy()).toBe("pair");
    expect(fresh.snapshot().users).toEqual([]);
  });

  it("讀到舊 schema（allowFrom）會被忽略，當作空白名單", () => {
    // v0.0.1 → v0.1.0 沒做 migration；舊資料應一筆都讀不進來
    const legacyFile = join(tmp, "legacy.json");
    Bun.write(legacyFile, JSON.stringify({
      dmPolicy: "allowlist",
      allowFrom: [VALID_USER_A],
      pendingPairs: {},
    }));
    const legacy = new AccessStore(legacyFile);
    // policy 仍能讀到（與 users 解析無關）
    expect(legacy.policy()).toBe("allowlist");
    // 但 users 會是空（不認 allowFrom）
    expect(legacy.snapshot().users).toEqual([]);
    expect(legacy.isAllowed(VALID_USER_A)).toBe(false);
  });
});
