import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySignature(
  rawBody: Buffer | Uint8Array | string,
  signatureHeader: string | undefined | null,
  channelSecret: string,
): boolean {
  if (!signatureHeader || !channelSecret) return false;
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody);
  const expectedB64 = createHmac("sha256", channelSecret).update(body).digest("base64");
  const expected = Buffer.from(expectedB64, "base64");
  let received: Buffer;
  try {
    received = Buffer.from(signatureHeader, "base64");
  } catch {
    return false;
  }
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}

export function computeSignature(rawBody: Buffer | Uint8Array | string, channelSecret: string): string {
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody);
  return createHmac("sha256", channelSecret).update(body).digest("base64");
}
