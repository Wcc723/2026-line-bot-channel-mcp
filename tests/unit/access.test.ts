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
    if (r.ok) expect(r.userId).toBe(VALID_USER_A);
    expect(store.isAllowed(VALID_USER_A)).toBe(true);
  });

  it("redeem 不存在的 code → code_not_found", () => {
    const r = store.redeemPairCode("000000");
    expect(r).toEqual({ ok: false, reason: "code_not_found" });
  });

  it("redeem 過期 code → code_expired", () => {
    const created = Date.now() - PAIR_CODE_TTL_MS - 1000;
    const code = store.createPairCode(VALID_USER_A, created);
    const r = store.redeemPairCode(code, Date.now());
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
    expect(snap.allowFrom.filter((u) => u === VALID_USER_A).length).toBe(1);
  });

  it("invalid userId 不能 allow", () => {
    expect(() => store.allow("nope")).toThrow();
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
    snap.allowFrom.push(VALID_USER_B);
    expect(store.isAllowed(VALID_USER_B)).toBe(false);
  });

  it("檔案不存在時用預設值", () => {
    const fresh = new AccessStore(join(tmp, "nope.json"));
    expect(fresh.policy()).toBe("pair");
    expect(fresh.snapshot().allowFrom).toEqual([]);
  });
});
