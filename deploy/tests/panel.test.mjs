import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

const image = process.argv[2];
const expectedRevision = process.argv[3];
if (!image) throw new Error("Usage: node deploy/tests/panel.test.mjs IMAGE");
const suffix = randomBytes(8).toString("hex");
const container = `bifurcation-smoke-${suffix}`;
const volume = `bifurcation-smoke-data-${suffix}`;
const key = randomBytes(32).toString("hex");
const password = randomBytes(24).toString("hex");
const publicOrigin = "http://localhost:3000";

function docker(args, required = true) {
  const result = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (required && result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function start() {
  docker(["run", "-d", "--name", container, "--init",
    "-p", "127.0.0.1::3000", "-v", `${volume}:/data`,
    "-e", `BIFURCATION_PUBLIC_URL=${publicOrigin}`,
    "-e", "BIFURCATION_DATABASE_PATH=/data/panel.sqlite",
    "-e", `BIFURCATION_APP_KEY=${key}`, image]);
  const port = docker(["port", container, "3000/tcp"]).split(":").at(-1);
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  let health;
  while (true) {
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2000) });
      health = await response.json();
      if (response.ok && health.status === "ok") break;
    } catch { /* The process may still be starting. */ }
    if (Date.now() >= deadline) throw new Error("Container health timed out");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (expectedRevision) assert.equal(health.revision, expectedRevision, "Image revision does not match the build");
  const login = await fetch(`${origin}/login`);
  assert.equal(login.status, 200, "SSR login route failed");
  assert.match(await login.text(), /Passkey/);
  return origin;
}

async function rpc(origin, method, body = {}, cookie) {
  const response = await fetch(`${origin}/rpc/bifurcation.panel.v1.${method}`, {
    method: "POST", signal: AbortSignal.timeout(15_000),
    headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1", Origin: publicOrigin, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, `${method} failed with HTTP ${response.status}`);
  return { body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
}

function accountSnapshot() {
  return docker(["exec", container, "node", "-e",
    "const D=require('better-sqlite3');const d=new D(process.env.BIFURCATION_DATABASE_PATH,{readonly:true});console.log(JSON.stringify(d.prepare('SELECT id,username,status FROM users ORDER BY id').all()));d.close()"]);
}

try {
  docker(["volume", "create", volume]);
  let origin = await start();
  const home = await fetch(origin);
  assert.match(await home.text(), /创建管理员/, "Empty deployment did not expose first administrator setup");
  const setup = await rpc(origin, "AuthService/SetupAdministrator", { username: "smoke-admin", password });
  assert.equal(setup.body.user.username, "smoke-admin");
  assert.ok(setup.cookie, "Setup did not establish a session");
  assert.equal((await rpc(origin, "MeService/GetMe", {}, setup.cookie)).body.user.id, setup.body.user.id);

  // Keep the standalone administrator CLI path covered without replacing the
  // first-run browser flow or mixing its pending account into the live database.
  const cliDatabase = ["-e", "BIFURCATION_DATABASE_PATH=/data/cli-smoke.sqlite"];
  docker(["exec", ...cliDatabase, container, "node", "scripts/migrate.mjs"]);
  const activation = docker(["exec", ...cliDatabase, container, "node", "scripts/admin.mjs", "init", "cli-admin"]);
  assert.match(activation, /http:\/\/localhost:3000\/activate\?token=/);
  const recovery = docker(["exec", container, "node", "scripts/admin.mjs", "recover", "smoke-admin"]);
  assert.match(recovery, /http:\/\/localhost:3000\/recover\?token=/);
  const before = accountSnapshot();
  assert.equal(JSON.parse(before).length, 1);
  docker(["stop", "--time", "10", container]);
  docker(["rm", container]);
  origin = await start();
  assert.equal(accountSnapshot(), before, "Container recreation lost account data");
  assert.equal((await rpc(origin, "MeService/GetMe", {}, setup.cookie)).body.user.id, setup.body.user.id, "Container recreation lost the established session");
  const login = await rpc(origin, "AuthService/PasswordLogin", { username: "smoke-admin", password });
  assert.equal(login.body.user.id, setup.body.user.id, "Container recreation lost the password credential");
  assert.ok(login.cookie, "Password login did not establish a session");
  console.log("PASS: container health, SSR, first administrator setup, CLI activation/recovery, and account/session/password persistence across recreation");
} catch (error) {
  console.error(docker(["logs", "--tail", "40", container], false));
  throw error;
} finally {
  docker(["rm", "-f", container], false);
  docker(["volume", "rm", volume], false);
}
