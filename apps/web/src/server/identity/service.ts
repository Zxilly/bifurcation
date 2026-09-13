import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { ApiKeyDto, UserDto } from "@/contracts/identity";
import { getDatabase } from "../db";
import { apiKeys, authFlows, passwords, passkeys, rateLimits, sessions, users } from "../db/schema";
import { hashPassword, newId, newToken, tokenHash, verifyPassword } from "../crypto";
import { AppError } from "../http/errors";
import { getEnvironment } from "../runtime/env";

const SESSION_COOKIE = "bifurcation_session";
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
export const RECENT_TTL = 10 * 60 * 1000;
export const passwordInput = z.string().min(12, "密码至少 12 位").max(256);
export const usernameInput = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_.-]{2,31}$/, "用户名为 3–32 位小写字母、数字、点、下划线或短横线");
export const quotaInput = z.string().regex(/^(0|[1-9]\d*)$/).refine((value) => BigInt(value) <= 9223372036854775807n, "额度超出范围").nullable();
export type Principal = { user: UserDto; authentication: "session" | "apiKey"; sessionHash?: string; recentAuthentication: boolean };

export function userDto(row: typeof users.$inferSelect): UserDto { return { ...row }; }

export function authenticate(request: Request): Principal {
  const { db } = getDatabase();
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const match = /^Bearer ([A-Za-z0-9_-]{10,200})$/.exec(authorization);
    if (!match) throw new AppError("UNAUTHENTICATED", "API Key 无效", 401);
    const key = db.select().from(apiKeys).where(and(eq(apiKeys.tokenHash, tokenHash(match[1])), isNull(apiKeys.revokedAt))).get();
    const user = key && db.select().from(users).where(eq(users.id, key.userId)).get();
    if (!key || !user || user.status !== "active") throw new AppError("UNAUTHENTICATED", "API Key 无效", 401);
    db.update(apiKeys).set({ lastUsedAt: Date.now() }).where(eq(apiKeys.id, key.id)).run();
    return { user: userDto(user), authentication: "apiKey", recentAuthentication: false };
  }
  const token = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!token) throw new AppError("UNAUTHENTICATED", "请先登录", 401);
  const sessionHash = tokenHash(token);
  const session = db.select().from(sessions).where(eq(sessions.tokenHash, sessionHash)).get();
  const user = session && db.select().from(users).where(eq(users.id, session.userId)).get();
  if (!session || session.expiresAt <= Date.now() || !user || user.status !== "active") throw new AppError("UNAUTHENTICATED", "登录已失效", 401);
  return { user: userDto(user), authentication: "session", sessionHash, recentAuthentication: session.reauthAt + RECENT_TTL > Date.now() };
}
export function requireAdmin(principal: Principal) {
  const current = getDatabase().db.select().from(users).where(eq(users.id, principal.user.id)).get();
  if (!current || current.status !== "active" || current.role !== "admin") throw new AppError("FORBIDDEN", "需要管理员权限", 403);
}
export function requireRecentSession(principal: Principal) {
  if (principal.authentication !== "session") throw new AppError("SESSION_REQUIRED", "此操作需要网页登录", 403);
  if (!principal.recentAuthentication) throw new AppError("REAUTH_REQUIRED", "请重新验证身份", 403);
}
export function issueSession(userId: string) {
  const token = newToken();
  // getDatabase returns the same connection: calls inside db.transaction participate in that transaction.
  getDatabase().db.insert(sessions).values({ tokenHash: tokenHash(token), userId, reauthAt: Date.now(), expiresAt: Date.now() + SESSION_TTL }).run();
  return token;
}
export function sessionCookie(token: string) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token ? SESSION_TTL / 1000 : 0}${getEnvironment().secureCookies ? "; Secure" : ""}`;
}
export function consumeRateLimit(key: string, limit = 8, windowMs = 15 * 60 * 1000) {
  const { db } = getDatabase();
  db.transaction((tx) => {
    const now = Date.now();
    const existing = tx.select().from(rateLimits).where(eq(rateLimits.key, key)).get();
    if (!existing || existing.resetsAt <= now) {
      tx.insert(rateLimits).values({ key, attempts: 1, resetsAt: now + windowMs }).onConflictDoUpdate({ target: rateLimits.key, set: { attempts: 1, resetsAt: now + windowMs } }).run();
    } else {
      if (existing.attempts >= limit) throw new AppError("RATE_LIMITED", "尝试次数过多，请稍后重试", 429);
      tx.update(rateLimits).set({ attempts: existing.attempts + 1 }).where(eq(rateLimits.key, key)).run();
    }
  });
}
let dummyHash: Promise<string> | undefined;
export async function passwordLogin(input: unknown) {
  const { username, password } = z.object({ username: usernameInput, password: z.string().min(1).max(256) }).parse(input);
  consumeRateLimit("password:global", 60, 60_000);
  consumeRateLimit("password:" + username);
  const { db } = getDatabase();
  const user = db.select().from(users).where(eq(users.username, username)).get();
  const credential = user && db.select().from(passwords).where(eq(passwords.userId, user.id)).get();
  dummyHash ??= hashPassword(newToken());
  const valid = await verifyPassword(credential?.hash ?? await dummyHash, password);
  if (!valid || !user || !credential || user.status !== "active") throw new AppError("INVALID_CREDENTIALS", "用户名或密码不正确", 401);
  return db.transaction((tx) => {
    const fresh = tx.select().from(users).where(eq(users.id, user.id)).get();
    const currentPassword = tx.select().from(passwords).where(eq(passwords.userId, user.id)).get();
    if (!fresh || fresh.status !== "active" || currentPassword?.hash !== credential.hash) throw new AppError("INVALID_CREDENTIALS", "登录凭据已改变", 401);
    tx.delete(rateLimits).where(eq(rateLimits.key, "password:" + username)).run();
    return { user: userDto(fresh), token: issueSession(user.id) };
  });
}
export async function reauthenticatePassword(principal: Principal, input: unknown) {
  if (!principal.sessionHash) throw new AppError("SESSION_REQUIRED", "需要网页登录", 403);
  const { password } = z.object({ password: z.string().min(1).max(256) }).parse(input);
  consumeRateLimit("reauth:" + principal.user.id);
  const { db } = getDatabase();
  const credential = db.select().from(passwords).where(eq(passwords.userId, principal.user.id)).get();
  if (!credential || !await verifyPassword(credential.hash, password)) throw new AppError("INVALID_CREDENTIALS", "密码不正确", 401);
  const updated = db.update(sessions).set({ reauthAt: Date.now() }).where(and(eq(sessions.tokenHash, principal.sessionHash), eq(sessions.userId, principal.user.id))).run();
  if (!updated.changes) throw new AppError("UNAUTHENTICATED", "登录已失效", 401);
  return { ok: true };
}
export function logout(principal: Principal) {
  if (principal.sessionHash) getDatabase().db.delete(sessions).where(eq(sessions.tokenHash, principal.sessionHash)).run();
}
export function listApiKeys(principal: Principal): ApiKeyDto[] {
  return getDatabase().db.select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, createdAt: apiKeys.createdAt, lastUsedAt: apiKeys.lastUsedAt, revokedAt: apiKeys.revokedAt }).from(apiKeys).where(eq(apiKeys.userId, principal.user.id)).all();
}
export function createApiKey(principal: Principal, input: unknown) {
  const { name } = z.object({ name: z.string().trim().min(1).max(64) }).parse(input);
  const token = newToken("bf_key_");
  const apiKey = { id: newId(), userId: principal.user.id, name, prefix: token.slice(0, 15), tokenHash: tokenHash(token), createdAt: Date.now(), lastUsedAt: null, revokedAt: null };
  getDatabase().db.insert(apiKeys).values(apiKey).run();
  return { apiKey: listApiKeys(principal).find((key) => key.id === apiKey.id)!, token };
}
export function revokeApiKey(principal: Principal, id: string) {
  const result = getDatabase().db.update(apiKeys).set({ revokedAt: Date.now() }).where(and(eq(apiKeys.id, id), eq(apiKeys.userId, principal.user.id))).run();
  if (!result.changes) throw new AppError("NOT_FOUND", "API Key 不存在", 404);
  return { ok: true };
}
export async function changePassword(principal: Principal, input: unknown) {
  requireRecentSession(principal);
  const { password } = z.object({ password: passwordInput }).parse(input);
  const hash = await hashPassword(password);
  const { db } = getDatabase();
  db.transaction((tx) => {
    const session = tx.select().from(sessions).where(eq(sessions.tokenHash, principal.sessionHash!)).get();
    if (!session || session.reauthAt + RECENT_TTL <= Date.now()) throw new AppError("REAUTH_REQUIRED", "请重新验证身份", 403);
    tx.update(passwords).set({ hash, changedAt: Date.now() }).where(eq(passwords.userId, principal.user.id)).run();
    tx.delete(sessions).where(eq(sessions.userId, principal.user.id)).run();
  });
  return { ok: true };
}
export function listPasskeys(principal: Principal) {
  return getDatabase().db.select({ id: passkeys.id, name: passkeys.name, backedUp: passkeys.backedUp, createdAt: passkeys.createdAt }).from(passkeys).where(eq(passkeys.userId, principal.user.id)).all();
}
export function deletePasskey(principal: Principal, id: string) {
  requireRecentSession(principal);
  const { db } = getDatabase();
  db.transaction((tx) => {
    const keys = tx.select().from(passkeys).where(eq(passkeys.userId, principal.user.id)).all();
    if (!keys.some((key) => key.id === id)) throw new AppError("NOT_FOUND", "Passkey 不存在", 404);
    if (keys.length <= 1) throw new AppError("LAST_PASSKEY", "请先添加另一个 Passkey", 409);
    tx.delete(passkeys).where(eq(passkeys.id, id)).run();
  });
  return { ok: true };
}
export function issueOnboarding(userId: string, purpose: "activation" | "recovery") {
  const { db } = getDatabase();
  const token = newToken();
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
  db.transaction((tx) => {
    tx.update(authFlows).set({ consumedAt: Date.now() }).where(and(eq(authFlows.userId, userId), eq(authFlows.purpose, purpose), isNull(authFlows.consumedAt))).run();
    tx.insert(authFlows).values({ id: newId(), purpose, userId, tokenHash: tokenHash(token), expiresAt }).run();
  });
  return { url: `${getEnvironment().publicUrl}/${purpose === "activation" ? "activate" : "recover"}?token=${token}`, expiresAt };
}
