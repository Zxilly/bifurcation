import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

const image = process.argv[2];
if (!image) throw new Error("Usage: node deploy/tests/panel.test.mjs IMAGE");
const suffix = randomBytes(8).toString("hex");
const container = `bifurcation-smoke-${suffix}`;
const volume = `bifurcation-smoke-data-${suffix}`;
const key = randomBytes(32).toString("hex");

function docker(args, required = true) {
  const result = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (required && result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function start() {
  docker(["run", "-d", "--name", container, "--init",
    "-p", "127.0.0.1::3000", "-v", `${volume}:/data`,
    "-e", "BIFURCATION_PUBLIC_URL=http://localhost:3000",
    "-e", "BIFURCATION_DATABASE_PATH=/data/panel.sqlite",
    "-e", `BIFURCATION_APP_KEY=${key}`, image]);
  const port = docker(["port", container, "3000/tcp"]).split(":").at(-1);
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok && (await response.json()).status === "ok") break;
    } catch { /* The process may still be starting. */ }
    if (Date.now() >= deadline) throw new Error("Container health timed out");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const login = await fetch(`${origin}/login`);
  assert.equal(login.status, 200, "SSR login route failed");
  assert.match(await login.text(), /Passkey/);
}

function accountSnapshot() {
  return docker(["exec", container, "node", "-e",
    "const D=require('better-sqlite3');const d=new D(process.env.BIFURCATION_DATABASE_PATH,{readonly:true});console.log(JSON.stringify(d.prepare('SELECT id,username,status FROM users ORDER BY id').all()));d.close()"]);
}

try {
  docker(["volume", "create", volume]);
  await start();
  const activation = docker(["exec", container, "node", "scripts/admin.mjs", "init", "smoke-admin"]);
  assert.match(activation, /http:\/\/localhost:3000\/activate\?token=/);
  const before = accountSnapshot();
  assert.equal(JSON.parse(before).length, 1);
  docker(["stop", "--time", "10", container]);
  docker(["rm", container]);
  await start();
  assert.equal(accountSnapshot(), before, "Container recreation lost account data");
  console.log("PASS: container health, SSR, administrator CLI and persistent volume recreation");
} catch (error) {
  console.error(docker(["logs", "--tail", "40", container], false));
  throw error;
} finally {
  docker(["rm", "-f", container], false);
  docker(["volume", "rm", volume], false);
}
