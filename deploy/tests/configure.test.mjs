import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parseEnv } from "node:util";

const script = resolve(import.meta.dirname, "../configure.mjs");
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "bifurcation-configure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { path: join(directory, ".env"), run: (...args) => spawnSync(process.execPath, [script, ...args], { cwd: directory, encoding: "utf8" }) };
}

test("first deployment creates a private persistent key without printing it", (t) => {
  const { path, run } = fixture(t);
  const result = run("--url", "https://panel.example.com/", "--port", "8300");
  assert.equal(result.status, 0, result.stderr);
  const contents = readFileSync(path, "utf8");
  const env = parseEnv(contents);
  assert.equal(env.BIFURCATION_PUBLIC_URL, "https://panel.example.com");
  assert.equal(env.BIFURCATION_PORT, "8300");
  assert.match(env.BIFURCATION_APP_KEY, /^[a-f0-9]{64}$/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(env.BIFURCATION_APP_KEY));
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  const repeated = run("--url", "https://different.example.com");
  assert.equal(repeated.status, 1);
  assert.match(repeated.stderr, /未覆盖/);
  assert.equal(readFileSync(path, "utf8"), contents);
  assert.equal(run("--check").status, 0);
  assert.equal(readFileSync(path, "utf8"), contents);
});

test("invalid public origins and ports do not create deployment state", (t) => {
  const { path, run } = fixture(t);
  for (const args of [[], ["--url", "http://panel.example.com"], ["--url", "https://panel.example.com/path"],
    ["--url", "https://user:secret@panel.example.com"], ["--url", "https://panel.example.com?x=1"],
    ["--url", "https://panel.example.com", "--port", "65536"], ["--url", "https://panel.example.com", "--port", "1e3"]]) {
    const result = run(...args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.equal(existsSync(path), false);
    assert.ok(!result.stderr.includes("user:secret"));
  }
});

test("local trial works, while checks reject an unusable key without replacing it", (t) => {
  const { path, run } = fixture(t);
  assert.equal(run("--url", "http://localhost:3000").status, 0);
  const contents = readFileSync(path, "utf8").replace(/BIFURCATION_APP_KEY=\w+/, "BIFURCATION_APP_KEY=wrong-key");
  writeFileSync(path, contents);
  const result = run("--check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /原密钥/);
  assert.ok(!result.stderr.includes("wrong-key"));
  assert.equal(readFileSync(path, "utf8"), contents);
});
