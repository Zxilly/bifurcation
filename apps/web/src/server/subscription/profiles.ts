import "server-only";
import { and, asc, eq, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import { getDatabase, type DatabaseHandle } from "@/server/db";
import { subscriptions, subscriptionPreviews, subscriptionTokens } from "@/server/db/schema-proxy";
import { decryptSecret, encryptSecret, newId, newToken, sha256, tokenHash } from "@/server/crypto";
import { getEnvironment } from "@/server/runtime/env";
import { AppError } from "@/server/http/errors";
import { jsonBytes, renderClient } from "@/server/adapters/sing-box";
import { subscriptionSnapshot } from "./snapshot";
import { defaultDraft, draftSchema, legacyDraft, renderSubscription, type SubscriptionDraft } from "./template";

type Row = typeof subscriptions.$inferSelect;
const nameSchema = z.string().trim().min(1).max(64);

export class SubscriptionProfileStore {
  constructor(private readonly handle: DatabaseHandle = getDatabase()) {}

  ensureLegacy(userId: string) {
    const token = this.handle.db.select().from(subscriptionTokens).where(eq(subscriptionTokens.userId, userId)).get();
    if (!token) return;
    const id = `default:${userId}`;
    if (this.handle.db.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.id, id)).get()) return;
    const draft = legacyDraft(subscriptionSnapshot(userId, this.handle));
    this.handle.db.insert(subscriptions).values({
      id, userId, name: "默认订阅", preset: "legacy", requestKey: "legacy", legacy: true,
      draftCiphertext: encryptSecret(JSON.stringify(draft)), publishedVersion: 1,
      tokenHash: token.tokenHash, tokenCiphertext: token.tokenCiphertext, generation: token.generation,
      createdAt: token.changedAt, updatedAt: token.changedAt,
    }).onConflictDoNothing().run();
  }

  syncLegacyToken(userId: string) {
    const token = this.handle.db.select().from(subscriptionTokens).where(eq(subscriptionTokens.userId, userId)).get();
    if (token) this.handle.db.update(subscriptions).set({ tokenHash: token.tokenHash, tokenCiphertext: token.tokenCiphertext, generation: token.generation })
      .where(eq(subscriptions.id, `default:${userId}`)).run();
  }

  private row(userId: string, id: string) {
    const row = this.handle.db.select().from(subscriptions).where(and(eq(subscriptions.id, id), eq(subscriptions.userId, userId), isNull(subscriptions.deletedAt))).get();
    if (!row) throw new AppError("SUBSCRIPTION_NOT_FOUND", "订阅不存在", 404);
    return row;
  }
  private checkVersion(row: Row, expected: number) {
    if (row.version !== expected) throw new AppError("VERSION_CONFLICT", "订阅已变化，请重新加载后再保存；当前编辑内容未被覆盖", 409);
  }
  private render(row: Row) {
    const snapshot = subscriptionSnapshot(row.userId, this.handle);
    if (snapshot.quota.user.status !== "active") throw new AppError("SUBSCRIPTION_DISABLED", "账号已禁用", 403);
    if (row.legacy && !row.publishedCiphertext) {
      // Preserve migrated URLs and their original client behavior until adoption.
      return { configJson: jsonBytes(renderClient(snapshot.nodes.filter((node) => node.available), snapshot.credentials.secrets, snapshot.blocked)).toString("utf8"), nodeCount: snapshot.blocked ? 0 : snapshot.nodes.filter((node) => node.available).length };
    }
    if (!row.publishedCiphertext) throw new AppError("SUBSCRIPTION_UNPUBLISHED", "请先预览并发布订阅配置", 422);
    return renderSubscription(JSON.parse(decryptSecret(row.publishedCiphertext)), snapshot);
  }
  private dto(row: Row, detail = false) {
    let configJson = ""; let generationError = ""; let nodeCount = 0;
    try { ({ configJson, nodeCount } = this.render(row)); }
    catch (error) { if (!(error instanceof AppError)) throw error; generationError = error.message; }
    return {
      id: row.id, name: row.name, preset: row.preset, version: row.version, publishedVersion: row.publishedVersion,
      enabled: row.enabled, legacy: row.legacy, generation: row.generation,
      url: detail ? `${getEnvironment().publicUrl}/s/${decryptSecret(row.tokenCiphertext)}` : "",
      draft: detail ? draftSchema.parse(JSON.parse(decryptSecret(row.draftCiphertext))) : undefined,
      configJson: detail ? configJson : "", generationError, nodeCount,
      lastFetchedAt: row.lastFetchedAt === null ? undefined : BigInt(row.lastFetchedAt),
    };
  }
  list(userId: string) {
    this.ensureLegacy(userId);
    return this.handle.db.select().from(subscriptions).where(and(eq(subscriptions.userId, userId), isNull(subscriptions.deletedAt))).orderBy(asc(subscriptions.createdAt), asc(subscriptions.id)).all().map((row) => this.dto(row));
  }
  get(userId: string, id: string) { return this.dto(this.row(userId, id), true); }

  create(userId: string, input: { name: string; preset: string; requestKey: string; copyFromId?: string }) {
    const name = nameSchema.parse(input.name);
    z.uuid().parse(input.requestKey);
    const preset = z.enum(["desktop", "mobile"]).parse(input.preset);
    return this.handle.db.transaction(() => {
      this.ensureLegacy(userId);
      const previous = this.handle.db.select().from(subscriptions).where(and(eq(subscriptions.userId, userId), eq(subscriptions.requestKey, input.requestKey))).get();
      if (previous) return this.get(userId, previous.id);
      if (this.handle.db.select({ id: subscriptions.id }).from(subscriptions).where(and(eq(subscriptions.userId, userId), isNull(subscriptions.deletedAt))).all().length >= 20) throw new AppError("SUBSCRIPTION_LIMIT", "最多可创建 20 条订阅", 422);
      const source = input.copyFromId ? this.row(userId, input.copyFromId) : undefined;
      const token = newToken("bf_sub_"); const id = newId(); const now = Date.now();
      this.handle.db.insert(subscriptions).values({
        id, userId, name, preset: source?.preset ?? preset, requestKey: input.requestKey,
        draftCiphertext: source?.draftCiphertext ?? encryptSecret(JSON.stringify(defaultDraft(preset))),
        tokenHash: tokenHash(token), tokenCiphertext: encryptSecret(token), createdAt: now, updatedAt: now,
      }).run();
      return this.get(userId, id);
    });
  }
  save(userId: string, id: string, expectedVersion: number, name: string, input: SubscriptionDraft) {
    const draft = draftSchema.parse(input);
    return this.handle.db.transaction(() => {
      const row = this.row(userId, id); this.checkVersion(row, expectedVersion);
      this.handle.db.update(subscriptions).set({ name: nameSchema.parse(name), draftCiphertext: encryptSecret(JSON.stringify(draft)), version: row.version + 1, updatedAt: Date.now() }).where(eq(subscriptions.id, id)).run();
      return this.get(userId, id);
    });
  }
  preview(userId: string, id: string, expectedVersion: number) {
    const row = this.row(userId, id); this.checkVersion(row, expectedVersion);
    const draft = draftSchema.parse(JSON.parse(decryptSecret(row.draftCiphertext)));
    const result = renderSubscription(draft, subscriptionSnapshot(userId, this.handle));
    const previewId = newId(); const expiresAt = Date.now() + 5 * 60_000; const digest = sha256(Buffer.from(result.configJson));
    this.handle.db.transaction(() => {
      this.handle.db.delete(subscriptionPreviews).where(lt(subscriptionPreviews.expiresAt, Date.now() - 24 * 60 * 60_000)).run();
      this.handle.db.insert(subscriptionPreviews).values({ id: previewId, subscriptionId: id, version: row.version, digest, expiresAt }).run();
    });
    return { ...result, previewId, digest, expiresAt: BigInt(expiresAt) };
  }
  publish(userId: string, id: string, expectedVersion: number, previewId: string) {
    return this.handle.db.transaction(() => {
      const row = this.row(userId, id);
      const preview = this.handle.db.select().from(subscriptionPreviews).where(and(eq(subscriptionPreviews.id, previewId), eq(subscriptionPreviews.subscriptionId, id))).get();
      if (!preview) throw new AppError("PREVIEW_NOT_FOUND", "请先生成预览", 422);
      if (preview.published) return this.get(userId, id);
      this.checkVersion(row, expectedVersion);
      if (preview.version !== row.version || preview.expiresAt <= Date.now()) throw new AppError("PREVIEW_EXPIRED", "草稿已变化或预览已过期，请重新预览", 409);
      const current = renderSubscription(JSON.parse(decryptSecret(row.draftCiphertext)), subscriptionSnapshot(userId, this.handle));
      if (sha256(Buffer.from(current.configJson)) !== preview.digest) throw new AppError("STALE_POLICY", "节点属性、配置或授权已变化，请重新预览", 409);
      this.handle.db.update(subscriptions).set({ publishedCiphertext: row.draftCiphertext, publishedVersion: row.version + 1, version: row.version + 1, legacy: false, updatedAt: Date.now() }).where(eq(subscriptions.id, id)).run();
      this.handle.db.update(subscriptionPreviews).set({ published: true }).where(eq(subscriptionPreviews.id, previewId)).run();
      return this.get(userId, id);
    });
  }
  update(userId: string, id: string, expectedVersion: number, action: string) {
    z.enum(["pause", "resume", "rotate", "delete"]).parse(action);
    return this.handle.db.transaction(() => {
      const row = this.row(userId, id); this.checkVersion(row, expectedVersion);
      const token = action === "rotate" ? newToken("bf_sub_") : null;
      const updated = this.handle.db.update(subscriptions).set({
        version: row.version + 1, updatedAt: Date.now(),
        ...(action === "pause" ? { enabled: false } : action === "resume" ? { enabled: true } : {}),
        ...(action === "delete" ? { deletedAt: Date.now(), enabled: false } : {}),
        ...(token ? { tokenHash: tokenHash(token), tokenCiphertext: encryptSecret(token), generation: row.generation + 1 } : {}),
      }).where(eq(subscriptions.id, id)).returning().get();
      if (token && id === `default:${userId}`) this.handle.db.update(subscriptionTokens).set({ tokenHash: updated.tokenHash, tokenCiphertext: updated.tokenCiphertext, generation: updated.generation, changedAt: Date.now() }).where(eq(subscriptionTokens.userId, userId)).run();
      return this.dto(updated, true);
    });
  }
  byToken(token: string) {
    if (!/^bf_sub_[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError("SUBSCRIPTION_NOT_FOUND", "订阅不存在", 404);
    const hash = tokenHash(token);
    let row = this.handle.db.select().from(subscriptions).where(eq(subscriptions.tokenHash, hash)).get();
    if (!row) {
      const legacy = this.handle.db.select().from(subscriptionTokens).where(eq(subscriptionTokens.tokenHash, hash)).get();
      if (legacy) { this.ensureLegacy(legacy.userId); row = this.handle.db.select().from(subscriptions).where(eq(subscriptions.tokenHash, hash)).get(); }
    }
    if (!row || row.deletedAt !== null) throw new AppError("SUBSCRIPTION_NOT_FOUND", "订阅不存在", 404);
    if (!row.enabled) throw new AppError("SUBSCRIPTION_PAUSED", "订阅已暂停", 403);
    const result = this.render(row);
    this.handle.db.update(subscriptions).set({ lastFetchedAt: Date.now() }).where(eq(subscriptions.id, row.id)).run();
    return result.configJson;
  }
}
