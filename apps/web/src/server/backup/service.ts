import "server-only";
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants, copyFile, lstat, mkdir, open, readFile, rename, stat, unlink, writeFile, chmod } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { decryptSecret, sha256 } from "@/server/crypto";
import { getEnvironment } from "@/server/runtime/env";

const metadataSchema = z.object({
  formatVersion: z.literal(1),
  createdAt: z.iso.datetime(),
  publicUrl: z.url(),
  timezone: z.literal("Asia/Shanghai"),
  applicationKeySha256: z.string().regex(/^[a-f0-9]{64}$/),
  databaseSha256: z.string().regex(/^[a-f0-9]{64}$/),
  migrations: z.array(z.object({ hash: z.string(), createdAt: z.number().int() })),
});
type BackupMetadata = z.infer<typeof metadataSchema>;

function keyFingerprint() { return sha256(getEnvironment().appKey); }
async function hashFile(path: string) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
async function syncFile(path: string) {
  const file = await open(path, "r+");
  try { await file.sync(); } finally { await file.close(); }
}
async function syncDirectory(path: string) {
  if (process.platform !== "linux") return;
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
async function requireRegularFile(path: string) {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`拒绝非普通文件：${path}`);
}
function inspectSnapshot(path: string, verifyKey: boolean) {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const check = database.pragma("quick_check") as { quick_check: string }[];
    if (check.length !== 1 || check[0].quick_check !== "ok") throw new Error("数据库完整性检查失败");
    if ((database.pragma("foreign_key_check") as unknown[]).length) throw new Error("数据库外键检查失败");
    const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name));
    if (!tables.has("users") || !tables.has("__drizzle_migrations")) throw new Error("备份不是 Bifurcation 面板数据库");
    if (verifyKey) {
      // Each supported ciphertext column uses the same persistent application key.
      const encrypted = [["machines", "token_ciphertext"], ["proxy_credentials", "secrets_ciphertext"], ["subscription_tokens", "token_ciphertext"], ["subscriptions", "token_ciphertext"], ["subscriptions", "draft_ciphertext"], ["subscriptions", "published_ciphertext"]] as const;
      for (const [table, column] of encrypted) {
        if (!tables.has(table)) continue;
        const sample = database.prepare(`SELECT ${column} AS secret FROM ${table} WHERE ${column} IS NOT NULL LIMIT 1`).get() as { secret: string } | undefined;
        if (sample) {
          try { decryptSecret(sample.secret); }
          catch { throw new Error("应用密钥无法解密数据库；请核对原 BIFURCATION_APP_KEY"); }
        }
      }
    }
    return (database.prepare("SELECT hash, created_at AS createdAt FROM __drizzle_migrations ORDER BY created_at, id").all() as { hash: string; createdAt: number }[]);
  } finally { database.close(); }
}

export async function createBackup(destination: string) {
  const env = getEnvironment();
  const directory = resolve(destination);
  await requireRegularFile(env.databasePath);
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  // Exclusive directory creation ensures retries never overwrite an older backup.
  await mkdir(directory, { mode: 0o700 });
  const snapshot = join(directory, "panel.sqlite");
  const source = new Database(env.databasePath, { readonly: true, fileMustExist: true });
  try { await source.backup(snapshot); } finally { source.close(); }
  await chmod(snapshot, 0o600);
  const migrations = inspectSnapshot(snapshot, true);
  const metadata: BackupMetadata = { formatVersion: 1, createdAt: new Date().toISOString(), publicUrl: env.publicUrl, timezone: "Asia/Shanghai", applicationKeySha256: keyFingerprint(), databaseSha256: await hashFile(snapshot), migrations };
  await syncFile(snapshot);
  const metadataPath = join(directory, "metadata.json");
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await syncFile(metadataPath); await syncDirectory(directory);
  return { directory, metadata };
}

export async function inspectBackup(directory: string) {
  const source = resolve(directory);
  const metadataPath = join(source, "metadata.json");
  await requireRegularFile(metadataPath);
  if ((await stat(metadataPath)).size > 1024 * 1024) throw new Error("备份元数据过大");
  const metadata = metadataSchema.parse(JSON.parse(await readFile(metadataPath, "utf8")));
  const snapshot = join(source, "panel.sqlite");
  await requireRegularFile(snapshot);
  if (await hashFile(snapshot) !== metadata.databaseSha256) throw new Error("备份数据库 SHA-256 不匹配");
  if (metadata.applicationKeySha256 !== keyFingerprint()) throw new Error("应用密钥摘要不匹配；请使用此备份对应的 BIFURCATION_APP_KEY");
  const migrations = inspectSnapshot(snapshot, true);
  if (JSON.stringify(migrations) !== JSON.stringify(metadata.migrations)) throw new Error("备份数据库迁移记录与元数据不匹配");
  return { directory: source, snapshot, metadata };
}

/** Call only inside the shared Linux flock held by scripts/backup.ts. */
export async function restoreBackupLocked(directory: string) {
  if (process.platform !== "linux") throw new Error("恢复仅支持持有共享 flock 的 Linux 部署");
  const env = getEnvironment();
  const backup = await inspectBackup(directory);
  const target = env.databasePath;
  if (resolve(backup.snapshot) === target) throw new Error("备份文件不能同时作为恢复目标");
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  let exists = false;
  try { await requireRegularFile(target); exists = true; }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  const stage = join(dirname(target), `.${basename(target)}.restore-${randomUUID()}`);
  let previousSnapshot: string | null = null;
  try {
    await copyFile(backup.snapshot, stage, constants.COPYFILE_EXCL);
    await chmod(stage, 0o600);
    if (await hashFile(stage) !== backup.metadata.databaseSha256) throw new Error("备份在复制期间发生变化，恢复已停止");
    inspectSnapshot(stage, true);
    await syncFile(stage);
    if (exists) {
      previousSnapshot = `${target}.before-restore-${Date.now()}-${randomUUID()}.sqlite`;
      let current: Database.Database | undefined;
      try {
        current = new Database(target, { fileMustExist: true });
        await current.backup(previousSnapshot);
        await chmod(previousSnapshot, 0o600); await syncFile(previousSnapshot);
        // Checkpoint before replacing the main file: a crash before the atomic
        // rename must still leave the old main database independently complete.
        const checkpoint = current.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
        if (checkpoint.some((row) => row.busy !== 0)) throw new Error("现有数据库仍被其他连接占用，恢复已停止");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && ["SQLITE_CORRUPT", "SQLITE_NOTADB"].includes(String(error.code)))) throw error;
        // A corrupt current database must not make restoration impossible.
        // Preserve its raw bytes; any WAL/SHM companions are retained below.
        previousSnapshot += ".raw";
        await copyFile(target, previousSnapshot, constants.COPYFILE_EXCL);
        await chmod(previousSnapshot, 0o600); await syncFile(previousSnapshot);
      } finally { current?.close(); }
    }
    for (const suffix of ["-wal", "-shm"]) {
      const companion = target + suffix;
      try {
        await requireRegularFile(companion);
        if (!exists) throw new Error("目标存在孤立 WAL/SHM 文件，请先保留并检查旧状态");
        await rename(companion, `${previousSnapshot}${suffix}`);
      } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    }
    // Linux rename replaces the path atomically on the same filesystem.
    await rename(stage, target);
    await syncDirectory(dirname(target));
    return { databasePath: target, previousSnapshot, metadata: backup.metadata };
  } finally {
    await unlink(stage).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
}
