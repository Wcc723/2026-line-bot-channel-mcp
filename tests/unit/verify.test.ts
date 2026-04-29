import { describe, expect, it } from "bun:test";
import { computeSignature, verifySignature } from "../../src/line/verify.ts";

const SECRET = "my-channel-secret";
const BODY = '{"events":[{"type":"message","webhookEventId":"abc"}]}';

describe("verifySignature", () => {
  it("有效簽章通過", () => {
    const sig = computeSignature(BODY, SECRET);
    expect(verifySignature(BODY, sig, SECRET)).toBe(true);
  });

  it("接受 Buffer 輸入", () => {
    const buf = Buffer.from(BODY, "utf8");
    const sig = computeSignature(buf, SECRET);
    expect(verifySignature(buf, sig, SECRET)).toBe(true);
  });

  it("接受 Uint8Array 輸入", () => {
    const arr = new TextEncoder().encode(BODY);
    const sig = computeSignature(arr, SECRET);
    expect(verifySignature(arr, sig, SECRET)).toBe(true);
  });

  it("body 被竄改 → false", () => {
    const sig = computeSignature(BODY, SECRET);
    expect(verifySignature(BODY + " ", sig, SECRET)).toBe(false);
  });

  it("錯誤的 secret → false", () => {
    const sig = computeSignature(BODY, SECRET);
    expect(verifySignature(BODY, sig, "wrong-secret")).toBe(false);
  });

  it("缺 signature header → false", () => {
    expect(verifySignature(BODY, undefined, SECRET)).toBe(false);
    expect(verifySignature(BODY, null, SECRET)).toBe(false);
    expect(verifySignature(BODY, "", SECRET)).toBe(false);
  });

  it("空 secret → false", () => {
    const sig = computeSignature(BODY, SECRET);
    expect(verifySignature(BODY, sig, "")).toBe(false);
  });

  it("空 body 仍可驗證", () => {
    const sig = computeSignature("", SECRET);
    expect(verifySignature("", sig, SECRET)).toBe(true);
  });

  it("竄改 signature header → false", () => {
    const sig = computeSignature(BODY, SECRET);
    const tampered = sig.slice(0, -2) + (sig.slice(-2) === "AA" ? "BB" : "AA");
    expect(verifySignature(BODY, tampered, SECRET)).toBe(false);
  });

  it("亂碼 signature header 不會丟錯", () => {
    expect(verifySignature(BODY, "***not-base64***", SECRET)).toBe(false);
  });
});
