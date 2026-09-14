import "server-only";
import { and, eq } from "drizzle-orm";
import type { SubscriptionDto } from "@/contracts/subscription";
import { getDatabase, type DatabaseHandle } from "@/server/db";
import { proxyCredentials, subscriptionTokens } from "@/server/db/schema-proxy";
import { decryptSecret, encryptSecret, newToken, tokenHash } from "@/server/crypto";
import { getEnvironment } from "@/server/runtime/env";
import { AppError } from "@/server/http/errors";
import { CONFIG_FORMAT_VERSION, jsonBytes, renderClient } from "@/server/adapters/sing-box";
import { ConfigurationStore } from "@/server/configuration/store";
import { readProxyCredentials } from "./credentials";

import { subscriptionSnapshot } from "./snapshot";
import { SubscriptionProfileStore } from "./profiles";

export class SubscriptionStore {
  constructor(private readonly handle: DatabaseHandle = getDatabase()) {}

  get(userId: string): SubscriptionDto {
    const credentials = readProxyCredentials(userId, this.handle);
    const token = this.handle.db.select().from(subscriptionTokens).where(eq(subscriptionTokens.userId, userId)).get();
    if (!token) throw new AppError("SUBSCRIPTION_NOT_READY", "订阅正在准备，请稍后刷新", 409);
    const { quota, blocked, nodes } = subscriptionSnapshot(userId, this.handle);
    return {
      url: `${getEnvironment().publicUrl}/s/${decryptSecret(token.tokenCiphertext)}`,
      generation: token.generation,
      credentialGeneration: credentials.generation,
      configFormatVersion: CONFIG_FORMAT_VERSION,
      blocked,
      blockReason: quota.user.status !== "active" ? "disabled" : quota.blocked ? "quota" : null,
      nodes: blocked ? [] : nodes.map((node) => ({ machineId: node.id, name: node.name, address: node.address, region: node.region, tags: node.tags, protocols: ["trojan", "hysteria2"], configurationState: node.applied ? "applied" : "pending", available: node.available })),
      configJson: jsonBytes(renderClient(nodes.filter((node) => node.available), credentials.secrets, blocked)).toString("utf8"),
    };
  }
  byToken(token: string) {
    return new SubscriptionProfileStore(this.handle).byToken(token);
  }
  resetToken(userId: string): SubscriptionDto {
    new SubscriptionProfileStore(this.handle).ensureLegacy(userId);
    const token = newToken("bf_sub_");
    this.handle.db.transaction((tx) => {
      const previous = tx.select().from(subscriptionTokens).where(eq(subscriptionTokens.userId, userId)).get();
      if (!previous) throw new AppError("SUBSCRIPTION_NOT_READY", "订阅尚未准备", 409);
      tx.update(subscriptionTokens).set({ tokenHash: tokenHash(token), tokenCiphertext: encryptSecret(token), generation: previous.generation + 1, changedAt: Date.now() }).where(eq(subscriptionTokens.userId, userId)).run();
    });
    new SubscriptionProfileStore(this.handle).syncLegacyToken(userId);
    return this.get(userId);
  }
  resetProxyCredentials(userId: string): SubscriptionDto {
    this.handle.db.transaction((tx) => {
      const previous = readProxyCredentials(userId, this.handle);
      tx.update(proxyCredentials).set({ secretsCiphertext: encryptSecret(JSON.stringify({ trojanPassword: newToken(), hysteria2Password: newToken() })), generation: previous.generation + 1, changedAt: Date.now() }).where(and(eq(proxyCredentials.userId, userId), eq(proxyCredentials.generation, previous.generation))).run();
    });
    new ConfigurationStore(this.handle).reconcile();
    return this.get(userId);
  }
}
