import "server-only";
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual, hkdfSync } from "node:crypto";

/**
 * Server-side encryption for OAuth secrets (AES-256-GCM).
 *
 * Format: "v<keyVersion>.<iv b64url>.<ciphertext b64url>.<tag b64url>"
 * The key never leaves the server; the database only ever sees ciphertext.
 * `context` is bound as additional authenticated data, so a token encrypted
 * for one user cannot be decrypted as another user's (copy-paste attack).
 */

const b64u = (b: Buffer) => b.toString("base64url");
const fromB64u = (s: string) => Buffer.from(s, "base64url");

function deriveKey(masterKeyB64: string, purpose: string): Buffer {
  const master = Buffer.from(masterKeyB64, "base64");
  if (master.length !== 32) throw new Error("encryption key must be 32 bytes");
  return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), `customer-360/${purpose}`, 32));
}

export function encryptSecret(plaintext: string, masterKeyB64: string, keyVersion: number, context: string): string {
  const key = deriveKey(masterKeyB64, "token-encryption");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v${keyVersion}.${b64u(iv)}.${b64u(ct)}.${b64u(cipher.getAuthTag())}`;
}

export function decryptSecret(token: string, masterKeyB64: string, expectedVersion: number, context: string): string {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== `v${expectedVersion}`) {
    throw new Error("ciphertext format or key version mismatch");
  }
  const [, iv, ct, tag] = parts;
  const key = deriveKey(masterKeyB64, "token-encryption");
  const decipher = createDecipheriv("aes-256-gcm", key, fromB64u(iv));
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(fromB64u(tag));
  return Buffer.concat([decipher.update(fromB64u(ct)), decipher.final()]).toString("utf8");
}

/** HMAC-signed, expiring value for short-lived cookies (OAuth state). */
export function signValue(payload: object, masterKeyB64: string): string {
  const body = b64u(Buffer.from(JSON.stringify(payload), "utf8"));
  const mac = createHmac("sha256", deriveKey(masterKeyB64, "cookie-signing")).update(body).digest();
  return `${body}.${b64u(mac)}`;
}

export function verifySignedValue<T>(value: string, masterKeyB64: string): T | null {
  const [body, mac] = value.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", deriveKey(masterKeyB64, "cookie-signing")).update(body).digest();
  const given = fromB64u(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    return JSON.parse(fromB64u(body).toString("utf8")) as T;
  } catch {
    return null;
  }
}

export function randomToken(bytes = 32): string {
  return b64u(randomBytes(bytes));
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
