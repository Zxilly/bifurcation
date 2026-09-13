import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDatabase, type DatabaseHandle } from "@/server/db";
import { users } from "@/server/db/schema";
import { createBackup, inspectBackup } from "@/server/backup/service";
import { initializeUserSecrets } from "@/server/subscription/credentials";
import { newId } from "@/server/crypto";

describe("consistent panel backups", () => {
  let directory: string;
  let database: DatabaseHandle;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "bifurcation-backup-"));
    process.env.BIFURCATION_APP_KEY = "89".repeat(32);
    process.env.BIFURCATION_PUBLIC_URL = "http://localhost:3000";
    process.env.BIFURCATION_DATABASE_PATH = join(directory, "live.sqlite");
    database = openDatabase(process.env.BIFURCATION_DATABASE_PATH);
    const id = newId();
    database.db.insert(users).values({ id, username: "admin", role: "admin", status: "active", createdAt: Date.now() }).run();
    initializeUserSecrets(id, database);
  });
  afterEach(() => { database.sqlite.close(); rmSync(directory, { recursive: true, force: true }); });

  it("backs up committed WAL data while the source connection stays open and records only a key fingerprint", async () => {
    const destination = join(directory, "snapshot with spaces");
    const result = await createBackup(destination);
    expect(result.metadata.migrations).toHaveLength(1);
    expect(JSON.stringify(result.metadata)).not.toContain(process.env.BIFURCATION_APP_KEY);
    expect((await inspectBackup(destination)).metadata.databaseSha256).toBe(result.metadata.databaseSha256);
    database.db.insert(users).values({ id: newId(), username: "later", role: "user", status: "pending", createdAt: Date.now() }).run();
    const snapshot = new Database(join(destination, "panel.sqlite"), { readonly: true });
    try {
      expect((snapshot.prepare("SELECT username FROM users").all() as { username: string }[]).map((row) => row.username)).toEqual(["admin"]);
      expect(snapshot.pragma("quick_check", { simple: true })).toBe("ok");
    } finally { snapshot.close(); }
    expect(database.db.select().from(users).all()).toHaveLength(2);
    await expect(createBackup(destination)).rejects.toMatchObject({ code: "EEXIST" });
    expect((await inspectBackup(destination)).metadata.databaseSha256).toBe(result.metadata.databaseSha256);
  });
  it("rejects a mismatched application key and altered backup bytes", async () => {
    const destination = join(directory, "snapshot");
    await createBackup(destination);
    process.env.BIFURCATION_APP_KEY = "90".repeat(32);
    await expect(inspectBackup(destination)).rejects.toThrow("应用密钥摘要不匹配");
    await expect(createBackup(join(directory, "wrong-key"))).rejects.toThrow("应用密钥无法解密数据库");
    expect(existsSync(join(directory, "wrong-key", "metadata.json"))).toBe(false);
    process.env.BIFURCATION_APP_KEY = "89".repeat(32);
    appendFileSync(join(destination, "panel.sqlite"), "tampered bytes");
    await expect(inspectBackup(destination)).rejects.toThrow("SHA-256 不匹配");
    expect(readFileSync(join(destination, "metadata.json"), "utf8")).not.toContain(process.env.BIFURCATION_APP_KEY);
  });
});
