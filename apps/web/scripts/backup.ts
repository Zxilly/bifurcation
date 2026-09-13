import { spawnSync } from "node:child_process";
import { mkdirSync, closeSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBackup, inspectBackup, restoreBackupLocked } from "../src/server/backup/service";
import { getEnvironment } from "../src/server/runtime/env";

process.umask(0o077);
const [command, argument] = process.argv.slice(2);
if (!argument || !["create", "inspect", "restore", "restore-locked"].includes(command)) throw new Error("用法：backup.mjs create|inspect|restore <备份目录>");
const directory = resolve(argument);
if (command === "create") {
  const result = await createBackup(directory);
  console.log(`一致备份已写入 ${result.directory}`);
  console.log("备份不包含应用密钥；请另外保存 BIFURCATION_APP_KEY 或原 .env。");
} else if (command === "inspect") {
  const result = await inspectBackup(directory);
  console.log(JSON.stringify(result.metadata, null, 2));
} else if (command === "restore") {
  if (process.platform !== "linux") throw new Error("自动恢复仅支持 Linux flock；Windows 开发环境请停服后另行恢复，不能覆盖运行库");
  const target = getEnvironment().databasePath;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  closeSync(openSync(`${target}.lock`, "a", 0o600));
  const result = spawnSync("/usr/bin/flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "75", "--no-fork", `${target}.lock`, process.execPath, fileURLToPath(import.meta.url), "restore-locked", directory], { stdio: "inherit", env: { ...process.env, BIFURCATION_RESTORE_LOCK_HELD: "1" } });
  if (result.error) throw result.error;
  if (result.status === 75) throw new Error("面板仍持有数据库锁；请先停止使用此数据库的面板容器");
  process.exitCode = result.status ?? 1;
} else {
  if (process.env.BIFURCATION_RESTORE_LOCK_HELD !== "1") throw new Error("恢复必须通过共享 flock 入口执行");
  const result = await restoreBackupLocked(directory);
  console.log(`数据库已恢复到 ${result.databasePath}`);
  if (result.previousSnapshot) console.log(`恢复前数据库已保留在 ${result.previousSnapshot}`);
  console.log("应用密钥未被修改。启动面板后检查节点授权版本和用量高水位；旧备份无法补回已确认后删除的节点数据。");
}
