import "server-only";
import { and, asc, eq, isNull } from "drizzle-orm";
import { fromJsonString } from "@bufbuild/protobuf";
import { CoreHealth, MachineStatusSchema } from "@bifurcation/rpc";
import type { SubscriptionDto } from "@/contracts/subscription";
import type { MachineConfigurationInput } from "@/contracts/configuration";
import { getDatabase, type DatabaseHandle } from "@/server/db";
import { configRevisions, machineConfigs, policyState, proxyCredentials, subscriptionTokens } from "@/server/db/schema-proxy";
import { machines } from "@/server/db/schema-machines";
import { decryptSecret, encryptSecret, newToken, tokenHash } from "@/server/crypto";
import { getEnvironment } from "@/server/runtime/env";
import { AppError } from "@/server/http/errors";
import { CONFIG_FORMAT_VERSION, jsonBytes, renderClient } from "@/server/adapters/sing-box";
import { ConfigurationStore } from "@/server/configuration/store";
import { userQuota } from "@/server/configuration/policy";
import { readProxyCredentials } from "./credentials";
import { MachineStore } from "@/server/modules/machines/store";

export class SubscriptionStore {
  constructor(private readonly handle: DatabaseHandle = getDatabase()) {}

  get(userId: string): SubscriptionDto {
    const credentials = readProxyCredentials(userId, this.handle);
    const token = this.handle.db.select().from(subscriptionTokens).where(eq(subscriptionTokens.userId, userId)).get();
    if (!token) throw new AppError("SUBSCRIPTION_NOT_READY", "订阅正在准备，请稍后刷新", 409);
    const quota = userQuota(userId, this.handle);
    const blocked = quota.user.status !== "active" || quota.blocked;
    const latestPolicy = this.handle.db.select().from(policyState).where(eq(policyState.id, "global")).get()?.revision ?? 0;
    const records = this.handle.db.select({ machine: machines, configuration: machineConfigs }).from(machineConfigs).innerJoin(machines, eq(machineConfigs.machineId, machines.id))
      .where(isNull(machines.removedAt)).orderBy(asc(machines.name), asc(machines.id)).all().filter(({ machine, configuration }) => !!configuration.settingsCiphertext && !!configuration.desiredRevisionId && !new MachineStore(this.handle).isUninstalled(machine.id, machine.bindingEpoch));
    const nodes = records.map(({ machine, configuration }) => {
      const status = machine.statusJson ? fromJsonString(MachineStatusSchema, machine.statusJson) : undefined;
      const effective = status?.appliedRevisionId ? this.handle.db.select().from(configRevisions).where(and(eq(configRevisions.id, status.appliedRevisionId), eq(configRevisions.machineId, machine.id))).get() : undefined;
      const authorizationCurrent = !!status && status.appliedPolicyRevision >= BigInt(Math.max(configuration.desiredPolicyRevision, latestPolicy));
      const available = !!effective && status?.coreHealth === CoreHealth.HEALTHY && authorizationCurrent;
      return { id: machine.id, name: machine.name, address: machine.address, settings: JSON.parse(decryptSecret(effective?.settingsCiphertext ?? configuration.settingsCiphertext!)) as MachineConfigurationInput, available, applied: status?.appliedRevisionId === configuration.desiredRevisionId && authorizationCurrent };
    });
    return {
      url: `${getEnvironment().publicUrl}/s/${decryptSecret(token.tokenCiphertext)}`,
      generation: token.generation,
      credentialGeneration: credentials.generation,
      configFormatVersion: CONFIG_FORMAT_VERSION,
      blocked,
      blockReason: quota.user.status !== "active" ? "disabled" : quota.blocked ? "quota" : null,
      nodes: blocked ? [] : nodes.map((node) => ({ machineId: node.id, name: node.name, address: node.address, protocols: ["trojan", "hysteria2"], configurationState: node.applied ? "applied" : "pending", available: node.available })),
      configJson: jsonBytes(renderClient(nodes.filter((node) => node.available), credentials.secrets, blocked)).toString("utf8"),
    };
  }
  byToken(token: string) {
    if (!/^bf_sub_[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError("SUBSCRIPTION_NOT_FOUND", "订阅不存在", 404);
    const row = this.handle.db.select().from(subscriptionTokens).where(eq(subscriptionTokens.tokenHash, tokenHash(token))).get();
    if (!row) throw new AppError("SUBSCRIPTION_NOT_FOUND", "订阅不存在", 404);
    const subscription = this.get(row.userId);
    if (subscription.blockReason === "disabled") throw new AppError("SUBSCRIPTION_DISABLED", "账号已禁用", 403);
    return subscription.configJson;
  }
  resetToken(userId: string): SubscriptionDto {
    const token = newToken("bf_sub_");
    this.handle.db.transaction((tx) => {
      const previous = tx.select().from(subscriptionTokens).where(eq(subscriptionTokens.userId, userId)).get();
      if (!previous) throw new AppError("SUBSCRIPTION_NOT_READY", "订阅尚未准备", 409);
      tx.update(subscriptionTokens).set({ tokenHash: tokenHash(token), tokenCiphertext: encryptSecret(token), generation: previous.generation + 1, changedAt: Date.now() }).where(eq(subscriptionTokens.userId, userId)).run();
    });
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
