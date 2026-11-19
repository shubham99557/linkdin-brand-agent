import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM encryption for third-party access tokens (LinkedIn API Terms §7.1(a): encryption at rest).
 * The key lives outside the database (env / secret manager). Ciphertext is bound to the account via
 * additional authenticated data, so a ciphertext copied to another account fails to decrypt.
 * Format: v1.<iv>.<tag>.<ciphertext>  (base64url parts)
 */
export function parseTokenKey(base64Key: string | undefined): Buffer {
  if (!base64Key) throw new Error("LBE_TOKEN_ENC_KEY is not set");
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) throw new Error("LBE_TOKEN_ENC_KEY must be 32 bytes, base64-encoded");
  return key;
}

const aad = (accountId: string) => Buffer.from(`lbe:linkedin-token:${accountId}`, "utf8");

export function encryptToken(key: Buffer, accountId: string, token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(accountId));
  const ct = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptToken(key: Buffer, accountId: string, payload: string): string {
  const [v, iv, tag, ct] = payload.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("unsupported token ciphertext format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(aad(accountId));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}
