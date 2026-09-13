import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { getEnvironment } from "../runtime/env";

export const newId = () => randomUUID();
export const newToken = (prefix = "") => prefix + randomBytes(32).toString("base64url");
export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const tokenHash = (value: string) => sha256(value);
// Argon2id is the library default; its ambient const enum cannot be used with isolatedModules.
export const hashPassword = (value: string) => hash(value, { memoryCost: 65536, timeCost: 3, parallelism: 1 });
export const verifyPassword = (hash: string, value: string) => verify(hash, value);

export function encryptSecret(value: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEnvironment().appKey, nonce);
  cipher.setAAD(Buffer.from("bifurcation:v1"));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}
export function decryptSecret(value: string): string {
  const [version, nonce, tag, ciphertext, extra] = value.split(".");
  if (version !== "v1" || !nonce || !tag || ciphertext === undefined || extra) throw new Error("不支持的密文格式");
  const decipher = createDecipheriv("aes-256-gcm", getEnvironment().appKey, Buffer.from(nonce, "base64url"));
  decipher.setAAD(Buffer.from("bifurcation:v1"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}
