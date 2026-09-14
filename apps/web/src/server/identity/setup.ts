import "server-only";
import { z } from "zod";
import { getDatabase } from "../db";
import { passwords, users } from "../db/schema";
import { hashPassword, newId } from "../crypto";
import { AppError } from "../http/errors";
import { initializeUserSecrets } from "../subscription/credentials";
import { PolicyStore } from "../configuration/policy";
import { consumeRateLimit, issueSession, passwordInput, usernameInput, userDto } from "./service";

export function needsSetup() {
  return !getDatabase().db.select({ id: users.id }).from(users).limit(1).get();
}

function requireSetup() {
  if (!needsSetup()) throw new AppError("SETUP_COMPLETE", "初始化已完成，请登录。", 409);
}

export async function setupAdministrator(input: unknown) {
  requireSetup();
  const { username, password } = z.object({ username: usernameInput, password: passwordInput }).parse(input);
  consumeRateLimit("setup", 15);
  const hash = await hashPassword(password);
  // Recheck under a write lock after hashing: only one caller can claim setup.
  return getDatabase().db.transaction((tx) => {
    requireSetup();
    const user = { id: newId(), username, role: "admin" as const, status: "active" as const, version: 1, monthlyLimitBytes: null, createdAt: Date.now() };
    tx.insert(users).values(user).run();
    tx.insert(passwords).values({ userId: user.id, hash, changedAt: Date.now() }).run();
    initializeUserSecrets(user.id);
    new PolicyStore().refresh();
    return { user: userDto(user), token: issueSession(user.id) };
  }, { behavior: "immediate" });
}
