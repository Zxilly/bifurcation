import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { getDatabase, openDatabase, type DatabaseHandle } from "../src/server/db";
import { passwords, passkeys, users } from "../src/server/db/schema";
import { newId, encryptSecret, decryptSecret } from "../src/server/crypto";
import { authenticate, changePassword, reauthenticatePassword, createApiKey, issueOnboarding, passwordLogin, consumeRateLimit, issueSession, revokeApiKey } from "../src/server/identity/service";
import { authenticationOptions, authenticationVerify, onboardingComplete, onboardingOptions, newPasskeyOptions, newPasskeyVerify } from "../src/server/identity/webauthn";
import { createUser, updateUser } from "../src/server/users/service";
import { checkOrigin, withApi, readJson } from "../src/server/http/route";
import { authenticator } from "./authenticator";
import { needsSetup, setupAdministrator } from "../src/server/identity/setup";

const globals = globalThis as typeof globalThis & { bifurcationDatabase?: DatabaseHandle };
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "bifurcation-identity-"));
  process.env.BIFURCATION_DATABASE_PATH = join(directory, "panel.sqlite");
  process.env.BIFURCATION_PUBLIC_URL = "http://localhost:3000";
  process.env.BIFURCATION_APP_KEY = "ab".repeat(32);
});
afterEach(() => { globals.bifurcationDatabase?.sqlite.close(); delete globals.bifurcationDatabase; rmSync(directory, { recursive: true, force: true }); });
const request = (token: string) => new Headers({ cookie: `bifurcation_session=${token}` });
async function activateAdmin(password = "correct horse battery staple") {
  const userId = newId();
  getDatabase().db.insert(users).values({ id: userId, username: "admin", role: "admin", status: "pending", createdAt: Date.now() }).run();
  const token = new URL(issueOnboarding(userId, "activation").url).searchParams.get("token")!;
  const options = await onboardingOptions("activation", { token });
  const device = authenticator();
  const completion = { token, flowId: options.flowId, response: device.register(options.options.challenge), password };
  const result = await onboardingComplete("activation", completion);
  return { ...result, device, completion, principal: authenticate(request(result.token)) };
}

describe("persistent identity boundary", () => {
  it("creates exactly one initial administrator under concurrent setup requests and keeps setup closed", async () => {
    expect(needsSetup()).toBe(true);
    const attempts = await Promise.allSettled([
      setupAdministrator({ username: "first", password: "1" }),
      setupAdministrator({ username: "second", password: "2" }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const winner = attempts.find((attempt) => attempt.status === "fulfilled")!;
    if (winner.status !== "fulfilled") throw new Error("No successful setup");
    expect(authenticate(request(winner.value.token)).user.role).toBe("admin");
    expect(getDatabase().db.select().from(users).all()).toHaveLength(1);
    expect(getDatabase().db.select().from(passwords).all()).toHaveLength(1);
    expect(needsSetup()).toBe(false);
    const loser = attempts.find((attempt) => attempt.status === "rejected");
    expect(loser).toMatchObject({ reason: { code: "SETUP_COMPLETE" } });
    getDatabase().sqlite.close(); delete globals.bifurcationDatabase;
    await expect(setupAdministrator({ username: "third", password: "3" })).rejects.toMatchObject({ code: "SETUP_COMPLETE" });
  });
  it("does not reopen setup for pending or disabled accounts", async () => {
    const id = newId();
    getDatabase().db.insert(users).values({ id, username: "reserved", role: "admin", status: "pending", createdAt: Date.now() }).run();
    expect(needsSetup()).toBe(false);
    await expect(setupAdministrator({ username: "intruder", password: "1" })).rejects.toMatchObject({ code: "SETUP_COMPLETE" });
    getDatabase().db.update(users).set({ status: "disabled" }).where(eq(users.id, id)).run();
    expect(needsSetup()).toBe(false);
    await expect(setupAdministrator({ username: "intruder", password: "1" })).rejects.toMatchObject({ code: "SETUP_COMPLETE" });
  });
  it("activates with only a password, rejects replay, and supports disabling, re-enabling and adding a Passkey", async () => {
    const admin = await activateAdmin();
    const created = createUser(admin.principal, { username: "password-only" });
    const token = new URL(created.activationUrl).searchParams.get("token")!;
    const options = await onboardingOptions("activation", { token });
    const completion = { token, flowId: options.flowId, password: "1", passwordOnly: true };
    await expect(onboardingComplete("activation", { ...completion, token: "x".repeat(43) })).rejects.toMatchObject({ code: "INVALID_FLOW" });
    await expect(onboardingComplete("activation", { ...completion, flowId: newId() })).rejects.toMatchObject({ code: "INVALID_FLOW" });
    await expect(onboardingComplete("recovery", completion)).rejects.toMatchObject({ code: "INVALID_FLOW" });
    await expect(onboardingComplete("activation", { ...completion, passwordOnly: false })).rejects.toThrow();
    await expect(onboardingComplete("activation", { ...completion, response: {} })).rejects.toThrow();
    const result = await onboardingComplete("activation", completion);
    expect(getDatabase().db.select().from(passkeys).where(eq(passkeys.userId, result.user.id)).all()).toEqual([]);
    await expect(onboardingComplete("activation", completion)).rejects.toMatchObject({ code: "INVALID_FLOW" });
    const disabled = updateUser(admin.principal, result.user.id, { expectedVersion: result.user.version, status: "disabled" }).user;
    await expect(passwordLogin({ username: "password-only", password: "1" })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    updateUser(admin.principal, result.user.id, { expectedVersion: disabled.version, status: "active" });
    const login = await passwordLogin({ username: "password-only", password: "1" });
    const principal = authenticate(request(login.token));
    const registration = await newPasskeyOptions(principal);
    await newPasskeyVerify(principal, { flowId: registration.flowId, response: authenticator().register(registration.options.challenge) });
    expect(getDatabase().db.select().from(passkeys).where(eq(passkeys.userId, result.user.id)).all()).toHaveLength(1);
  });
  it("password-only recovery revokes old Passkeys and sessions while preserving API keys", async () => {
    const admin = await activateAdmin();
    const key = createApiKey(admin.principal, { name: "keep" });
    const token = new URL(issueOnboarding(admin.user.id, "recovery").url).searchParams.get("token")!;
    const options = await onboardingOptions("recovery", { token });
    const completion = { token, flowId: options.flowId, password: "2", passwordOnly: true };
    await onboardingComplete("recovery", completion);
    expect(() => authenticate(request(admin.token))).toThrow("登录已失效");
    expect(getDatabase().db.select().from(passkeys).all()).toEqual([]);
    expect(authenticate(new Headers({ authorization: `Bearer ${key.token}` })).user.id).toBe(admin.user.id);
    await expect(passwordLogin({ username: "admin", password: admin.completion.password })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect((await passwordLogin({ username: "admin", password: "2" })).user.id).toBe(admin.user.id);
    await expect(onboardingComplete("recovery", completion)).rejects.toMatchObject({ code: "INVALID_FLOW" });
  });
  it.each(["1", "密", "a".repeat(257)])("accepts unrestricted nonempty passwords through activation, login and password changes (%#)", async (password) => {
    const admin = await activateAdmin(password);
    const login = await passwordLogin({ username: "admin", password });
    const principal = authenticate(request(login.token));
    await reauthenticatePassword(principal, { password });
    const replacement = password + "2";
    await changePassword(principal, { password: replacement });
    expect(() => authenticate(request(login.token))).toThrow("登录已失效");
    await expect(passwordLogin({ username: "admin", password })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    const updatedLogin = await passwordLogin({ username: "admin", password: replacement });
    expect(authenticate(request(updatedLogin.token)).user.id).toBe(admin.user.id);
  });
  it("activates atomically with a verified passkey and password, then rejects replay", async () => {
    const admin = await activateAdmin();
    expect(admin.user.status).toBe("active");
    const stored = getDatabase().db.select().from(passwords).get()!;
    expect(stored.hash).toMatch(/^\$argon2id\$/);
    await expect(onboardingComplete("activation", admin.completion)).rejects.toMatchObject({ code: "INVALID_FLOW" });
    const login = await passwordLogin({ username: "admin", password: admin.completion.password });
    expect(authenticate(request(login.token)).user.id).toBe(admin.user.id);
    getDatabase().sqlite.close(); delete globals.bifurcationDatabase;
    expect(authenticate(request(login.token)).user.id).toBe(admin.user.id);
  });
  it("verifies actual authentication signatures, origin, and one-use challenges", async () => {
    const admin = await activateAdmin();
    const options = await authenticationOptions({ purpose: "login" });
    await expect(authenticationVerify({ flowId: options.flowId, response: admin.device.authenticate(options.options.challenge, "https://wrong.example") })).rejects.toMatchObject({ code: "INVALID_PASSKEY" });
    const response = admin.device.authenticate(options.options.challenge);
    const result = await authenticationVerify({ flowId: options.flowId, response });
    expect(result.user.id).toBe(admin.user.id);
    await expect(authenticationVerify({ flowId: options.flowId, response })).rejects.toMatchObject({ code: "INVALID_FLOW" });
  });
  it("keeps invalid registration pending and rejects a flow bound to a different session", async () => {
    const admin = await activateAdmin();
    const created = createUser(admin.principal, { username: "member", role: "user", monthlyLimitBytes: "9223372036854775807" });
    const token = new URL(created.activationUrl).searchParams.get("token")!;
    const options = await onboardingOptions("activation", { token });
    await expect(onboardingComplete("activation", { token, flowId: options.flowId, response: authenticator().register(options.options.challenge, "https://bad.example"), password: "correct horse battery staple" })).rejects.toMatchObject({ code: "INVALID_PASSKEY" });
    expect(getDatabase().db.select().from(users).where(eq(users.id, created.user.id)).get()?.status).toBe("pending");
    const registration = await newPasskeyOptions(admin.principal);
    const otherSession = authenticate(request(issueSession(admin.user.id)));
    await expect(newPasskeyVerify(otherSession, { flowId: registration.flowId, response: authenticator().register(registration.options.challenge) })).rejects.toMatchObject({ code: "INVALID_FLOW" });
  });
  it("enforces current role/status for old keys and protects the last admin", async () => {
    const admin = await activateAdmin();
    expect(() => updateUser(admin.principal, admin.user.id, { expectedVersion: admin.user.version, status: "disabled" })).toThrow("最后一个");
    const second = createUser(admin.principal, { username: "second", role: "admin" });
    const token = new URL(second.activationUrl).searchParams.get("token")!;
    const options = await onboardingOptions("activation", { token });
    const result = await onboardingComplete("activation", { token, flowId: options.flowId, response: authenticator().register(options.options.challenge), password: "another secure password" });
    const secondPrincipal = authenticate(request(result.token));
    const key = createApiKey(secondPrincipal, { name: "automation" });
    const bearer = new Headers({ authorization: `Bearer ${key.token}` });
    updateUser(admin.principal, result.user.id, { expectedVersion: result.user.version, role: "user" });
    expect(authenticate(bearer).user.role).toBe("user");
    expect(() => createUser(authenticate(bearer), { username: "illegal" })).toThrow("管理员");
    updateUser(admin.principal, result.user.id, { expectedVersion: result.user.version + 1, status: "disabled" });
    expect(() => authenticate(bearer)).toThrow("API Key 无效");
  });
  it("preserves rate limits on reopen and rejects cookie mutations from another origin", () => {
    consumeRateLimit("login:admin", 1);
    getDatabase().sqlite.close(); delete globals.bifurcationDatabase;
    expect(() => consumeRateLimit("login:admin", 1)).toThrow("尝试次数");
    expect(() => checkOrigin(new Request("http://localhost:3000", { method: "POST", headers: { origin: "https://other.example" } }))).toThrow("来源");
    const cipher = encryptSecret("permanent-machine-token");
    expect(decryptSecret(cipher)).toBe("permanent-machine-token");
    process.env.BIFURCATION_APP_KEY = "cd".repeat(32);
    expect(() => decryptSecret(cipher)).toThrow();
  });
  it("recovery replaces login credentials and sessions while preserving long-lived API keys", async () => {
    const admin = await activateAdmin();
    const key = createApiKey(admin.principal, { name: "old key" });
    const token = new URL(issueOnboarding(admin.user.id, "recovery").url).searchParams.get("token")!;
    const options = await onboardingOptions("recovery", { token });
    const recovered = await onboardingComplete("recovery", { token, flowId: options.flowId, response: authenticator().register(options.options.challenge), password: "new password for recovery" });
    expect(authenticate(request(recovered.token)).user.id).toBe(admin.user.id);
    expect(() => authenticate(request(admin.token))).toThrow("登录已失效");
    expect(authenticate(new Headers({ authorization: `Bearer ${key.token}` })).user.id).toBe(admin.user.id);
    await expect(passwordLogin({ username: "admin", password: admin.completion.password })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    const loginOptions = await authenticationOptions({ purpose: "login" });
    await expect(authenticationVerify({ flowId: loginOptions.flowId, response: admin.device.authenticate(loginOptions.options.challenge) })).rejects.toMatchObject({ code: "INVALID_FLOW" });
    revokeApiKey(authenticate(request(recovered.token)), key.apiKey.id);
    expect(() => authenticate(new Headers({ authorization: `Bearer ${key.token}` }))).toThrow("API Key 无效");
  });
  it("checks authorization after a delayed request body has finished", async () => {
    const admin = await activateAdmin();
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { bodyController = controller; } });
    const delayedRequest = new Request("http://localhost:3000/api/v1/admin/users", { method: "POST", headers: { cookie: `bifurcation_session=${admin.token}`, origin: "http://localhost:3000", "content-type": "application/json" }, body, duplex: "half" } as RequestInit);
    const response = withApi(delayedRequest, async () => { await readJson(delayedRequest); return { incorrectlyAuthorized: true }; }, { admin: true });
    // Administrative state changes while the request is still sending its body.
    getDatabase().db.update(users).set({ role: "user" }).where(eq(users.id, admin.user.id)).run();
    bodyController.enqueue(new TextEncoder().encode("{}")); bodyController.close();
    expect((await response).status).toBe(403);
  });
  it("rolls back real SQLite transactions and preserves quota integers", () => {
    const handle = openDatabase(join(directory, "rollback.sqlite"));
    try {
      expect(() => handle.db.transaction((tx) => {
        tx.insert(users).values({ id: "rollback", username: "rollback", role: "user", status: "pending", createdAt: 1 }).run();
        throw new Error("failure");
      })).toThrow("failure");
      expect(handle.db.select().from(users).all()).toEqual([]);
      expect(handle.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally { handle.sqlite.close(); }
  });
});
