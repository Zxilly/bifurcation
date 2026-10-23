import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { getDatabase, type DatabaseHandle } from "@/server/db";
import { apiKeys, passkeys, sessions, users } from "@/server/db/schema";
import { machines } from "@/server/db/schema-machines";
import { newId } from "@/server/crypto";
import { authenticate, createApiKey, issueSession, logout, RECENT_TTL, revokeApiKey } from "@/server/identity/service";
import { createPanelRouter } from "@/server/rpc/panel/router";
import { handleConnectRequest } from "@/server/rpc/web-adapter";

const globals = globalThis as typeof globalThis & { bifurcationDatabase?: DatabaseHandle };

describe("panel Connect authorization at execution", () => {
  let directory: string;
  let userId: string;
  let headers: Headers;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "bifurcation-panel-rpc-"));
    process.env.BIFURCATION_DATABASE_PATH = join(directory, "panel.sqlite");
    process.env.BIFURCATION_PUBLIC_URL = "http://localhost:3000";
    process.env.BIFURCATION_APP_KEY = "ab".repeat(32);
    userId = newId();
    getDatabase().db.insert(users).values({ id: userId, username: "admin", role: "admin", status: "active", createdAt: Date.now() }).run();
    headers = new Headers({ cookie: `bifurcation_session=${issueSession(userId)}`, origin: "http://localhost:3000", "content-type": "application/json" });
  });
  afterEach(() => {
    globals.bifurcationDatabase?.sqlite.close();
    delete globals.bifurcationDatabase;
    rmSync(directory, { recursive: true, force: true });
  });

  async function delayedCall(method: string, input: unknown, duringRead: () => void, requestHeaders = headers) {
    const reading = Promise.withResolvers<void>();
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { bodyController = controller; },
      pull() { reading.resolve(); },
    }, { highWaterMark: 0 });
    const response = handleConnectRequest(createPanelRouter(), new Request(`http://localhost:3000/rpc/bifurcation.panel.v1.${method}`, {
      method: "POST", headers: requestHeaders, body, duplex: "half",
    } as RequestInit));
    // The real transport has passed its header gate and started consuming the
    // body; revoke authorization before completing the protobuf JSON message.
    await reading.promise;
    duringRead();
    bodyController.enqueue(new TextEncoder().encode(JSON.stringify(input)));
    bodyController.close();
    return response;
  }

  it("rechecks the administrator role before a delayed machine mutation", async () => {
    const response = await delayedCall("AdminMachineService/CreateMachine", { name: "Blocked node", address: "node.test" }, () => {
      getDatabase().db.update(users).set({ role: "user" }).where(eq(users.id, userId)).run();
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "permission_denied" });
    expect(getDatabase().db.select().from(machines).all()).toEqual([]);
  });

  it("rechecks account status before a delayed account mutation", async () => {
    const response = await delayedCall("MeService/CreateApiKey", { name: "Must not exist" }, () => {
      getDatabase().db.update(users).set({ status: "disabled" }).where(eq(users.id, userId)).run();
    });
    expect(response.status).toBe(401);
    expect(getDatabase().db.select().from(apiKeys).all()).toEqual([]);
  });

  it("rejects a key revoked during the body without falling back to its valid cookie", async () => {
    const principal = authenticate(headers);
    const key = createApiKey(principal, { name: "Original" });
    const bearer = new Headers(headers);
    bearer.set("authorization", `Bearer ${key.token}`);
    const response = await delayedCall("MeService/CreateApiKey", { name: "Must not exist" }, () => revokeApiKey(principal, key.apiKey.id), bearer);
    expect(response.status).toBe(401);
    expect(getDatabase().db.select().from(apiKeys).all()).toHaveLength(1);
  });

  it("rejects a session revoked while its body was in flight", async () => {
    const principal = authenticate(headers);
    const response = await delayedCall("MeService/CreateApiKey", { name: "Must not exist" }, () => logout(principal));
    expect(response.status).toBe(401);
    expect(getDatabase().db.select().from(apiKeys).all()).toEqual([]);
  });

  it("rechecks recent authentication before deleting a passkey", async () => {
    for (const id of ["first", "second"]) getDatabase().db.insert(passkeys).values({
      id, userId, name: id, publicKey: "test-public-key", counter: 0,
      transports: "[]", deviceType: "singleDevice", backedUp: false, createdAt: Date.now(),
    }).run();
    const principal = authenticate(headers);
    const response = await delayedCall("MeService/DeletePasskey", { id: "first" }, () => {
      getDatabase().db.update(sessions).set({ reauthAt: Date.now() - RECENT_TTL - 1 }).where(eq(sessions.tokenHash, principal.sessionHash!)).run();
    });
    expect(response.status).toBe(403);
    expect(getDatabase().db.select().from(passkeys).all()).toHaveLength(2);
  });

  it("allows a delayed mutation when authorization remains valid", async () => {
    const response = await delayedCall("AdminMachineService/CreateMachine", { name: "Approved node", address: "node.test" }, () => {});
    expect(response.status).toBe(200);
    expect(getDatabase().db.select({ name: machines.name }).from(machines).all()).toEqual([{ name: "Approved node" }]);
  });
});
