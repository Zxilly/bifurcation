import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDatabase } from "../db";
import { passwords, passkeys, sessions, users } from "../db/schema";
import { newId } from "../crypto";
import { AppError } from "../http/errors";
import { issueOnboarding, quotaInput, requireAdmin, usernameInput, userDto, type Principal } from "../identity/service";
import { PolicyStore } from "../configuration/policy";

export function listUsers(principal: Principal) {
  requireAdmin(principal);
  return getDatabase().db.select().from(users).all().map(userDto);
}
export function createUser(principal: Principal, input: unknown) {
  requireAdmin(principal);
  const parsed = z.object({ username: usernameInput, role: z.enum(["admin", "user"]).default("user"), monthlyLimitBytes: quotaInput.default(null) }).parse(input);
  const { db } = getDatabase();
  return db.transaction((tx) => {
    if (tx.select().from(users).where(eq(users.username, parsed.username)).get()) throw new AppError("USERNAME_EXISTS", "用户名已存在", 409);
    if (tx.select().from(users).all().length >= 10) throw new AppError("USER_LIMIT", "最多支持 10 个账号", 409);
    const user = { id: newId(), ...parsed, status: "pending" as const, version: 1, createdAt: Date.now() };
    tx.insert(users).values(user).run();
    return { user: userDto(user), activationUrl: issueOnboarding(user.id, "activation").url };
  });
}
export function updateUser(principal: Principal, id: string, input: unknown) {
  requireAdmin(principal);
  const parsed = z.object({ expectedVersion: z.number().int().positive(), role: z.enum(["admin", "user"]).optional(), status: z.enum(["active", "disabled"]).optional(), monthlyLimitBytes: quotaInput.optional() }).parse(input);
  const { expectedVersion, ...changes } = parsed;
  const { db } = getDatabase();
  return db.transaction((tx) => {
    const user = tx.select().from(users).where(eq(users.id, id)).get();
    if (!user) throw new AppError("NOT_FOUND", "账号不存在", 404);
    if (user.version !== expectedVersion) throw new AppError("VERSION_CONFLICT", "账号已更新，请刷新后重试", 409);
    if (changes.status === "active" && (!tx.select().from(passwords).where(eq(passwords.userId, id)).get() || !tx.select().from(passkeys).where(eq(passkeys.userId, id)).get())) throw new AppError("ACTIVATION_REQUIRED", "账号需要先完成激活", 409);
    if (user.role === "admin" && user.status === "active" && (changes.role === "user" || changes.status === "disabled")) {
      const admins = tx.select().from(users).where(and(eq(users.role, "admin"), eq(users.status, "active"))).all();
      if (admins.length <= 1) throw new AppError("LAST_ADMIN", "不能禁用或降级最后一个启用的管理员", 409);
    }
    const updated = { ...user, ...changes, version: user.version + 1 };
    tx.update(users).set({ ...changes, version: updated.version }).where(eq(users.id, id)).run();
    if (changes.status === "disabled") tx.delete(sessions).where(eq(sessions.userId, id)).run();
    new PolicyStore().refresh();
    return { user: userDto(updated) };
  });
}
export function createUserFlow(principal: Principal, id: string, purpose: "activation" | "recovery") {
  requireAdmin(principal);
  const user = getDatabase().db.select().from(users).where(eq(users.id, id)).get();
  if (!user) throw new AppError("NOT_FOUND", "账号不存在", 404);
  if ((purpose === "activation" && user.status !== "pending") || (purpose === "recovery" && user.status !== "active")) throw new AppError("INVALID_STATUS", "当前账号状态不支持此操作", 409);
  return issueOnboarding(id, purpose);
}
