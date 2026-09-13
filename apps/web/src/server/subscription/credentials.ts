import "server-only";
import { eq } from "drizzle-orm";
import { getDatabase, type DatabaseHandle } from "@/server/db";
import { proxyCredentials, subscriptionTokens } from "@/server/db/schema-proxy";
import { decryptSecret, encryptSecret, newToken, tokenHash } from "@/server/crypto";
import { AppError } from "@/server/http/errors";

type ProxySecrets = { trojanPassword: string; hysteria2Password: string };
export function initializeUserSecrets(userId: string, handle: DatabaseHandle = getDatabase()) {
  handle.db.transaction((tx) => {
    if (!tx.select().from(proxyCredentials).where(eq(proxyCredentials.userId, userId)).get()) {
      const secrets: ProxySecrets = { trojanPassword: newToken(), hysteria2Password: newToken() };
      tx.insert(proxyCredentials).values({ userId, secretsCiphertext: encryptSecret(JSON.stringify(secrets)), changedAt: Date.now() }).run();
    }
    if (!tx.select().from(subscriptionTokens).where(eq(subscriptionTokens.userId, userId)).get()) {
      const token = newToken("bf_sub_");
      tx.insert(subscriptionTokens).values({ userId, tokenHash: tokenHash(token), tokenCiphertext: encryptSecret(token), changedAt: Date.now() }).run();
    }
  });
}
export function readProxyCredentials(userId: string, handle: DatabaseHandle = getDatabase()) {
  const row = handle.db.select().from(proxyCredentials).where(eq(proxyCredentials.userId, userId)).get();
  if (!row) throw new AppError("SUBSCRIPTION_NOT_READY", "代理身份正在准备，请稍后刷新", 409);
  return { ...row, secrets: JSON.parse(decryptSecret(row.secretsCiphertext)) as ProxySecrets };
}
