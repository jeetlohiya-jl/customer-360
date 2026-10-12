import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, signValue, verifySignedValue, randomToken, safeEqual } from "@/lib/security/crypto";

const KEY = Buffer.alloc(32, 1).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 2).toString("base64");

describe("token encryption (AES-256-GCM)", () => {
  it("round-trips and never contains the plaintext", () => {
    const secret = "1//synthetic-refresh-token-value";
    const enc = encryptSecret(secret, KEY, 1, "gmail-refresh-token:user-a");
    expect(enc.startsWith("v1.")).toBe(true);
    expect(enc).not.toContain(secret);
    expect(decryptSecret(enc, KEY, 1, "gmail-refresh-token:user-a")).toBe(secret);
  });

  it("uses a fresh IV each time", () => {
    const a = encryptSecret("same", KEY, 1, "ctx");
    const b = encryptSecret("same", KEY, 1, "ctx");
    expect(a).not.toBe(b);
  });

  it("refuses another user's ciphertext (context is bound)", () => {
    const enc = encryptSecret("token-of-a", KEY, 1, "gmail-refresh-token:user-a");
    expect(() => decryptSecret(enc, KEY, 1, "gmail-refresh-token:user-b")).toThrow();
  });

  it("refuses tampering, the wrong key and the wrong key version", () => {
    const enc = encryptSecret("token", KEY, 1, "ctx");
    const parts = enc.split(".");
    const flipped = Buffer.from(parts[2], "base64url");
    flipped[0] ^= 1;
    parts[2] = flipped.toString("base64url");
    expect(() => decryptSecret(parts.join("."), KEY, 1, "ctx")).toThrow();
    expect(() => decryptSecret(enc, OTHER_KEY, 1, "ctx")).toThrow();
    expect(() => decryptSecret(enc, KEY, 2, "ctx")).toThrow();
  });
});

describe("signed values (OAuth state cookie)", () => {
  it("verifies its own signature and rejects edits or another key", () => {
    const v = signValue({ s: "state", u: "user" }, KEY);
    expect(verifySignedValue<{ s: string }>(v, KEY)?.s).toBe("state");
    const [body, mac] = v.split(".");
    const edited = Buffer.from(JSON.stringify({ s: "state", u: "attacker" })).toString("base64url");
    expect(verifySignedValue(`${edited}.${mac}`, KEY)).toBeNull();
    expect(verifySignedValue(`${body}.${mac}`, OTHER_KEY)).toBeNull();
    expect(verifySignedValue("garbage", KEY)).toBeNull();
  });

  it("random tokens are long and unique; safeEqual compares exactly", () => {
    const set = new Set(Array.from({ length: 50 }, () => randomToken()));
    expect(set.size).toBe(50);
    expect(randomToken().length).toBeGreaterThanOrEqual(43);
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
