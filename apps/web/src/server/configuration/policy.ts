import "server-only";
import { and, asc, eq } from "drizzle-orm";
import type { AuthorizationLayer } from "@/contracts/configuration";
import { getDatabase, type DatabaseHandle } from "@/server/db";
import { users } from "@/server/db/schema";
import { policyState, quotaStates, usageBuckets } from "@/server/db/schema-proxy";
import { initializeUserSecrets, readProxyCredentials } from "@/server/subscription/credentials";
import { sha256 } from "@/server/crypto";
import { MAX_BYTES, monthPeriod, monthStart } from "@/server/usage/time";
import { AppError } from "@/server/http/errors";

export function userQuota(userId: string, handle: DatabaseHandle = getDatabase(), now = Date.now()) {
  const user = handle.db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw new AppError("NOT_FOUND", "账号不存在", 404);
  const buckets = handle.db.select({ uploadBytes: usageBuckets.uploadBytes, downloadBytes: usageBuckets.downloadBytes }).from(usageBuckets)
    .where(and(eq(usageBuckets.userId, userId), eq(usageBuckets.grain, "month"), eq(usageBuckets.bucketStart, monthStart(now)))).all();
  const used = buckets.reduce((sum, row) => sum + BigInt(row.uploadBytes) + BigInt(row.downloadBytes), 0n);
  if (used > MAX_BYTES) throw new AppError("USAGE_OVERFLOW", "用户月用量超过计量范围", 409);
  const limit = user.monthlyLimitBytes === null ? null : BigInt(user.monthlyLimitBytes);
  const blocked = limit !== null && used >= limit;
  return { user, used, limit, blocked, period: monthPeriod(now) };
}
export class PolicyStore {
  constructor(private readonly handle: DatabaseHandle = getDatabase()) {}

  refresh(now = Date.now()): AuthorizationLayer {
    return this.handle.db.transaction((tx) => {
      const active = tx.select().from(users).where(eq(users.status, "active")).orderBy(asc(users.id)).all();
      const authorized: AuthorizationLayer["users"] = [];
      // Only the effective authorization set changes the floor, not role labels or raw counters.
      const fingerprintUsers: unknown[] = [];
      for (const user of active) {
        initializeUserSecrets(user.id, this.handle);
        const credentials = readProxyCredentials(user.id, this.handle);
        const quota = userQuota(user.id, this.handle, now);
        tx.insert(quotaStates).values({ userId: user.id, period: quota.period, usedBytes: quota.used.toString(), blocked: quota.blocked })
          .onConflictDoUpdate({ target: [quotaStates.userId, quotaStates.period], set: { usedBytes: quota.used.toString(), blocked: quota.blocked } }).run();
        if (!quota.blocked) {
          fingerprintUsers.push([user.id, credentials.generation]);
          authorized.push({ id: user.id, ...credentials.secrets });
        }
      }
      const period = monthPeriod(now);
      const fingerprint = sha256(JSON.stringify(fingerprintUsers));
      const previous = tx.select().from(policyState).where(eq(policyState.id, "global")).get();
      const changed = previous?.fingerprint !== fingerprint;
      const revision = previous ? previous.revision + (changed ? 1 : 0) : 1;
      if (!Number.isSafeInteger(revision)) throw new AppError("POLICY_OVERFLOW", "授权版本超出范围", 409);
      if (changed || previous?.period !== period) tx.insert(policyState).values({ id: "global", revision, fingerprint, period, updatedAt: now })
        .onConflictDoUpdate({ target: policyState.id, set: { revision, fingerprint, period, updatedAt: now } }).run();
      return { version: 1, policyRevision: String(revision), users: authorized };
    });
  }
}
