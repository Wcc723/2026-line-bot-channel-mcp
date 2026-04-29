import { describe, expect, it } from "bun:test";
import { ReplyTokenStore } from "../../src/line/replyStore.ts";

const USER = "U" + "a".repeat(32);

describe("ReplyTokenStore", () => {
  it("set 後可 take，取出後就消失", () => {
    const store = new ReplyTokenStore(1000);
    store.set(USER, "tok-1", 0);
    expect(store.peek(USER, 100)).toBe("tok-1");
    expect(store.take(USER, 100)).toBe("tok-1");
    expect(store.take(USER, 100)).toBeNull();
  });

  it("過期 token 取出回 null", () => {
    const store = new ReplyTokenStore(1000);
    store.set(USER, "tok-1", 0);
    expect(store.take(USER, 5_000)).toBeNull();
  });

  it("peek 過期會清掉", () => {
    const store = new ReplyTokenStore(1000);
    store.set(USER, "tok-1", 0);
    expect(store.peek(USER, 5_000)).toBeNull();
    expect(store.size()).toBe(0);
  });

  it("覆蓋同一 user 的 token", () => {
    const store = new ReplyTokenStore(1000);
    store.set(USER, "tok-1", 0);
    store.set(USER, "tok-2", 100);
    expect(store.take(USER, 200)).toBe("tok-2");
  });

  it("stop 清空所有 entries", () => {
    const store = new ReplyTokenStore(1000);
    store.set(USER, "tok-1", 0);
    store.stop();
    expect(store.size()).toBe(0);
  });
});
