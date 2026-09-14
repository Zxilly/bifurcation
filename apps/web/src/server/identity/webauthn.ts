import "server-only";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse, type AuthenticationResponseJSON, type RegistrationResponseJSON } from "@simplewebauthn/server";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDatabase } from "../db";
import { authFlows, passwords, passkeys, sessions, users } from "../db/schema";
import { getEnvironment } from "../runtime/env";
import { hashPassword, newId, tokenHash } from "../crypto";
import { AppError } from "../http/errors";
import { consumeRateLimit, issueSession, passwordInput, RECENT_TTL, requireRecentSession, userDto, type Principal } from "./service";
import { initializeUserSecrets } from "../subscription/credentials";
import { PolicyStore } from "../configuration/policy";

const responseInput = z.object({ id: z.string().min(1), rawId: z.string(), type: z.literal("public-key"), response: z.record(z.string(), z.unknown()), clientExtensionResults: z.record(z.string(), z.unknown()) }).passthrough();
const completionInput = z.object({ flowId: z.string().uuid(), response: responseInput, name: z.string().trim().min(1).max(64).default("Passkey") });
const invalidFlow = () => new AppError("INVALID_FLOW", "验证已失效，请重新开始", 400);

function loadFlow(id: string) {
  const flow = getDatabase().db.select().from(authFlows).where(eq(authFlows.id, id)).get();
  if (!flow || flow.consumedAt !== null || flow.expiresAt <= Date.now()) throw invalidFlow();
  return flow;
}
function consumeFlow(id: string) {
  const result = getDatabase().db.update(authFlows).set({ consumedAt: Date.now() }).where(and(eq(authFlows.id, id), isNull(authFlows.consumedAt))).run();
  if (!result.changes) throw invalidFlow();
}
function assertSession(principal: Principal) {
  requireRecentSession(principal);
  const session = getDatabase().db.select().from(sessions).where(eq(sessions.tokenHash, principal.sessionHash!)).get();
  if (!session || session.expiresAt <= Date.now() || session.reauthAt + RECENT_TTL <= Date.now()) throw invalidFlow();
}
export async function authenticationOptions(input: unknown, principal?: Principal) {
  const { purpose } = z.object({ purpose: z.enum(["login", "reauth"]).default("login") }).parse(input);
  if (purpose === "reauth" && !principal?.sessionHash) throw new AppError("SESSION_REQUIRED", "请先登录", 401);
  consumeRateLimit(purpose === "reauth" ? `webauthn-options:${principal!.user.id}` : "webauthn-options", 60, 60_000);
  const options = await generateAuthenticationOptions({ rpID: getEnvironment().rpId, userVerification: "required", ...(purpose === "reauth" ? { allowCredentials: getDatabase().db.select().from(passkeys).where(eq(passkeys.userId, principal!.user.id)).all().map((key) => ({ id: key.id, transports: JSON.parse(key.transports) })) } : {}) });
  const flowId = newId();
  getDatabase().db.insert(authFlows).values({ id: flowId, purpose, userId: purpose === "reauth" ? principal!.user.id : null, sessionHash: purpose === "reauth" ? principal!.sessionHash : null, challenge: options.challenge, expiresAt: Date.now() + 5 * 60_000 }).run();
  return { flowId, options };
}
export async function authenticationVerify(input: unknown, principal?: Principal) {
  const { flowId, response } = completionInput.parse(input);
  const flow = loadFlow(flowId);
  if (!flow.challenge || !["login", "reauth"].includes(flow.purpose)) throw invalidFlow();
  if (flow.purpose === "reauth" && (!principal?.sessionHash || flow.sessionHash !== principal.sessionHash || flow.userId !== principal.user.id)) throw invalidFlow();
  consumeRateLimit(`webauthn-verify:${response.id}`);
  const { db } = getDatabase();
  const key = db.select().from(passkeys).where(eq(passkeys.id, response.id)).get();
  const user = key && db.select().from(users).where(eq(users.id, key.userId)).get();
  if (!key || !user || user.status !== "active" || (flow.userId && flow.userId !== user.id)) throw invalidFlow();
  const env = getEnvironment();
  let verification;
  try {
    verification = await verifyAuthenticationResponse({ response: response as unknown as AuthenticationResponseJSON, expectedChallenge: flow.challenge, expectedOrigin: env.publicUrl, expectedRPID: env.rpId, requireUserVerification: true, credential: { id: key.id, publicKey: new Uint8Array(Buffer.from(key.publicKey, "base64url")), counter: key.counter, transports: JSON.parse(key.transports) } });
  } catch { throw new AppError("INVALID_PASSKEY", "Passkey 验证失败", 400); }
  if (!verification.verified) throw new AppError("INVALID_PASSKEY", "Passkey 验证失败", 400);
  return db.transaction((tx) => {
    loadFlow(flowId);
    const fresh = tx.select().from(users).where(eq(users.id, user.id)).get();
    const freshKey = tx.select().from(passkeys).where(eq(passkeys.id, key.id)).get();
    if (!fresh || fresh.status !== "active" || !freshKey || freshKey.counter !== key.counter || freshKey.publicKey !== key.publicKey || freshKey.userId !== key.userId) throw invalidFlow();
    consumeFlow(flowId);
    tx.update(passkeys).set({ counter: verification.authenticationInfo.newCounter, backedUp: verification.authenticationInfo.credentialBackedUp }).where(eq(passkeys.id, key.id)).run();
    if (flow.purpose === "reauth") {
      const updated = tx.update(sessions).set({ reauthAt: Date.now() }).where(eq(sessions.tokenHash, principal!.sessionHash!)).run();
      if (!updated.changes) throw invalidFlow();
      return { user: userDto(fresh) };
    }
    return { user: userDto(fresh), token: issueSession(user.id) };
  });
}
async function registrationOptions(user: typeof users.$inferSelect) {
  return generateRegistrationOptions({ rpName: "Bifurcation", rpID: getEnvironment().rpId, userName: user.username, userID: new TextEncoder().encode(user.id), attestationType: "none", authenticatorSelection: { residentKey: "required", userVerification: "required" }, excludeCredentials: getDatabase().db.select().from(passkeys).where(eq(passkeys.userId, user.id)).all().map((key) => ({ id: key.id, transports: JSON.parse(key.transports) })) });
}
export async function newPasskeyOptions(principal: Principal) {
  assertSession(principal);
  const options = await registrationOptions(principal.user);
  const flowId = newId();
  getDatabase().db.insert(authFlows).values({ id: flowId, purpose: "register", userId: principal.user.id, sessionHash: principal.sessionHash, challenge: options.challenge, expiresAt: Date.now() + 5 * 60_000 }).run();
  return { flowId, options };
}
async function verifyRegistration(response: unknown, challenge: string) {
  const env = getEnvironment();
  try {
    const result = await verifyRegistrationResponse({ response: response as RegistrationResponseJSON, expectedChallenge: challenge, expectedOrigin: env.publicUrl, expectedRPID: env.rpId, requireUserVerification: true });
    if (!result.verified) throw new Error("unverified");
    return result.registrationInfo;
  } catch { throw new AppError("INVALID_PASSKEY", "Passkey 注册验证失败", 400); }
}
function insertPasskey(userId: string, name: string, info: Awaited<ReturnType<typeof verifyRegistration>>) {
  const row = { id: info.credential.id, userId, name, publicKey: Buffer.from(info.credential.publicKey).toString("base64url"), counter: info.credential.counter, transports: JSON.stringify(info.credential.transports ?? []), deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp, createdAt: Date.now() };
  if (getDatabase().db.select().from(passkeys).where(eq(passkeys.id, row.id)).get()) throw new AppError("PASSKEY_EXISTS", "此 Passkey 已绑定账号", 409);
  getDatabase().db.insert(passkeys).values(row).run();
  return { id: row.id, name: row.name, backedUp: row.backedUp, createdAt: row.createdAt };
}
export async function newPasskeyVerify(principal: Principal, input: unknown) {
  assertSession(principal);
  const { flowId, response, name } = completionInput.parse(input);
  const flow = loadFlow(flowId);
  if (flow.purpose !== "register" || flow.userId !== principal.user.id || flow.sessionHash !== principal.sessionHash || !flow.challenge) throw invalidFlow();
  const info = await verifyRegistration(response, flow.challenge);
  return getDatabase().db.transaction(() => {
    assertSession(principal);
    loadFlow(flowId);
    consumeFlow(flowId);
    return { passkey: insertPasskey(principal.user.id, name, info) };
  });
}
function onboardingFlow(token: string, purpose: "activation" | "recovery") {
  const flow = getDatabase().db.select().from(authFlows).where(eq(authFlows.tokenHash, tokenHash(token))).get();
  if (!flow || flow.purpose !== purpose || !flow.userId) throw invalidFlow();
  loadFlow(flow.id);
  const user = getDatabase().db.select().from(users).where(eq(users.id, flow.userId)).get();
  if (!user || (purpose === "activation" ? user.status !== "pending" : user.status !== "active")) throw invalidFlow();
  return { flow, user };
}
export async function onboardingOptions(purpose: "activation" | "recovery", input: unknown) {
  const { token } = z.object({ token: z.string().min(32).max(128) }).parse(input);
  consumeRateLimit("onboarding:" + tokenHash(token), 15);
  const { flow, user } = onboardingFlow(token, purpose);
  const options = await registrationOptions(user);
  getDatabase().db.update(authFlows).set({ challenge: options.challenge }).where(eq(authFlows.id, flow.id)).run();
  return { flowId: flow.id, username: user.username, options };
}
export async function onboardingComplete(purpose: "activation" | "recovery", input: unknown) {
  const common = z.object({ token: z.string().min(32).max(128), flowId: z.string().uuid(), password: passwordInput });
  const parsed = z.discriminatedUnion("passwordOnly", [
    common.extend({ passwordOnly: z.literal(true), response: z.undefined().optional() }),
    common.extend({ passwordOnly: z.literal(false).default(false), response: responseInput, name: completionInput.shape.name }),
  ]).parse(input);
  const { token, flowId, password } = parsed;
  const { flow, user } = onboardingFlow(token, purpose);
  if (flow.id !== flowId || !flow.challenge) throw invalidFlow();
  consumeRateLimit("onboarding-complete:" + tokenHash(token), 15);
  const info = parsed.passwordOnly ? undefined : await verifyRegistration(parsed.response, flow.challenge);
  const hash = await hashPassword(password);
  return getDatabase().db.transaction((tx) => {
    const current = onboardingFlow(token, purpose);
    if (current.flow.challenge !== flow.challenge) throw invalidFlow();
    consumeFlow(flowId);
    if (purpose === "recovery") {
      tx.delete(passkeys).where(eq(passkeys.userId, user.id)).run();
      tx.delete(sessions).where(eq(sessions.userId, user.id)).run();
    }
    if (info && !parsed.passwordOnly) insertPasskey(user.id, parsed.name, info);
    tx.insert(passwords).values({ userId: user.id, hash, changedAt: Date.now() }).onConflictDoUpdate({ target: passwords.userId, set: { hash, changedAt: Date.now() } }).run();
    tx.update(users).set({ status: "active", version: current.user.version + 1 }).where(eq(users.id, user.id)).run();
    initializeUserSecrets(user.id);
    new PolicyStore().refresh();
    tx.update(authFlows).set({ consumedAt: Date.now() }).where(and(eq(authFlows.userId, user.id), isNull(authFlows.consumedAt))).run();
    return { user: userDto({ ...current.user, status: "active", version: current.user.version + 1 }), token: issueSession(user.id) };
  });
}
