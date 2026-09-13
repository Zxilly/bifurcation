// Run in a disposable Linux container with the production image and backup CLI.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";

assert.equal(process.env.BIFURCATION_DISPOSABLE_TEST_CONTAINER, "1");
assert.equal(existsSync("/.dockerenv"), true);
const require = createRequire("/app/apps/web/scripts/backup.mjs");
const Database = require("better-sqlite3");
const path = "/tmp/bifurcation-restore-test/live.sqlite";
mkdirSync("/tmp/bifurcation-restore-test", { recursive: true });
process.env.BIFURCATION_DATABASE_PATH = path;
process.env.BIFURCATION_PUBLIC_URL = "http://localhost:3000";
process.env.BIFURCATION_APP_KEY = "ab".repeat(32);
function cli(...args) {
  return spawnSync(process.execPath, ["/app/apps/web/scripts/backup.mjs", ...args], { env: process.env, encoding: "utf8" });
}
assert.equal(spawnSync(process.execPath, ["/app/apps/web/scripts/migrate.mjs"], { env: process.env, encoding: "utf8" }).status, 0);
const live = new Database(path);
live.pragma("journal_mode = WAL");
live.prepare("INSERT INTO users (id, username, role, status, version, created_at) VALUES (?, ?, 'admin', 'active', 1, 1)").run("test-admin", "before");
const backup = "/tmp/bifurcation-restore-test/snapshot";
let result = cli("create", backup);
assert.equal(result.status, 0, result.stderr);
live.prepare("UPDATE users SET username = 'after'").run();

// A separate process holds exactly the lock used by the production entrypoint.
const holder = spawn("/usr/bin/flock", ["--exclusive", "--no-fork", `${path}.lock`, "/bin/sh", "-c", "printf 'locked\\n'; exec sleep 60"], { stdio: ["ignore", "pipe", "inherit"] });
await once(holder.stdout, "data");
result = cli("restore", backup);
assert.notEqual(result.status, 0);
assert.match(result.stderr, /数据库锁/);
assert.equal(live.prepare("SELECT username FROM users").get().username, "after");
holder.kill("SIGTERM"); await once(holder, "exit");
live.close();

result = cli("restore", backup);
assert.equal(result.status, 0, result.stderr);
const restored = new Database(path);
assert.equal(restored.prepare("SELECT username FROM users").get().username, "before");
restored.close();
const preserved = readdirSync("/tmp/bifurcation-restore-test").find((name) => name.includes("before-restore-") && name.endsWith(".sqlite"));
assert.ok(preserved);
const previous = new Database(`/tmp/bifurcation-restore-test/${preserved}`, { readonly: true });
assert.equal(previous.prepare("SELECT username FROM users").get().username, "after");
previous.close();

// A killed writer leaves committed data in WAL without a normal close/checkpoint.
const writer = spawn(process.execPath, ["--input-type=module", "-e", `
  import { createRequire } from 'node:module';
  const require = createRequire('/app/apps/web/scripts/backup.mjs');
  const Database = require('better-sqlite3');
  const database = new Database(${JSON.stringify(path)});
  database.pragma('journal_mode = WAL'); database.pragma('wal_autocheckpoint = 0');
  database.prepare("UPDATE users SET username = 'wal-after'").run();
  console.log('written'); setInterval(() => {}, 1000);
`], { stdio: ["ignore", "pipe", "inherit"] });
await once(writer.stdout, "data"); writer.kill("SIGKILL"); await once(writer, "exit");
assert.equal(existsSync(`${path}-wal`), true);
result = cli("restore", backup);
assert.equal(result.status, 0, result.stderr);
const afterWalRestore = new Database(path, { readonly: true });
assert.equal(afterWalRestore.prepare("SELECT username FROM users").get().username, "before");
afterWalRestore.close();
let retainedWal = false;
for (const name of readdirSync("/tmp/bifurcation-restore-test").filter((name) => name.includes("before-restore-") && name.endsWith(".sqlite"))) {
  const database = new Database(`/tmp/bifurcation-restore-test/${name}`, { readonly: true });
  retainedWal ||= database.prepare("SELECT username FROM users").get().username === "wal-after";
  database.close();
}
assert.equal(retainedWal, true, 'The prior committed WAL data was not preserved');

process.env.BIFURCATION_APP_KEY = "cd".repeat(32);
result = cli("restore", backup);
assert.notEqual(result.status, 0);
assert.match(result.stderr, /密钥摘要不匹配/);
process.env.BIFURCATION_APP_KEY = "ab".repeat(32);

// Recovery from a corrupt current file preserves those original bytes as well.
writeFileSync(path, "corrupt current database");
result = cli("restore", backup);
assert.equal(result.status, 0, result.stderr);
const raw = readdirSync("/tmp/bifurcation-restore-test").find((name) => name.endsWith(".raw"));
assert.ok(raw);
assert.equal(readFileSync(`/tmp/bifurcation-restore-test/${raw}`, "utf8"), "corrupt current database");
const recovered = new Database(path, { readonly: true });
assert.equal(recovered.prepare("SELECT username FROM users").get().username, "before");
recovered.close();
console.log("Linux flock, consistent backup, atomic restore, key check and corrupt-file preservation verified.");
