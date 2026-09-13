import { createRequire } from "node:module";
import { readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { hash, verify } from "@node-rs/argon2";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { z } from "zod";

// Runs both in pnpm's portable deployment and in the final runtime filesystem.
// It requires no application secret and does not touch the persistent database.
const require = createRequire(import.meta.url);
require.resolve("next/dist/server/lib/start-server");
require.resolve("drizzle-orm/better-sqlite3/migrator");
require.resolve("@simplewebauthn/server");
assert.equal(z.string().parse("runtime"), "runtime");
const sqlite = new Database(":memory:");
try {
  const db = drizzle(sqlite);
  assert.equal(db.get("SELECT 1 AS ready").ready, 1);
} finally { sqlite.close(); }
const encoded = await hash("runtime native module check");
assert.equal(await verify(encoded, "runtime native module check"), true);
if (process.argv.includes("--standalone")) {
  // Turbopack externalizes native imports through generated, hashed aliases.
  // Normal package resolution alone does not exercise the instrumentation path.
  const nextDirectory = resolve(import.meta.dirname, "../.next");
  const aliasesDirectory = join(nextDirectory, "node_modules");
  const aliasRequire = createRequire(join(nextDirectory, "runtime-dependency-check.cjs"));
  const aliases = [];
  for (const entry of await readdir(aliasesDirectory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      for (const name of await readdir(join(aliasesDirectory, entry.name))) aliases.push(`${entry.name}/${name}`);
    } else aliases.push(entry.name);
  }
  assert.ok(aliases.some((name) => name.startsWith("better-sqlite3-")), "SQLite Turbopack alias is missing");
  assert.ok(aliases.some((name) => name.startsWith("@node-rs/argon2-")), "Argon2 Turbopack alias is missing");
  for (const name of aliases) {
    aliasRequire.resolve(name);
    if (name.startsWith("better-sqlite3-")) {
      const NativeDatabase = aliasRequire(name);
      const database = new NativeDatabase(":memory:");
      try { assert.equal(database.prepare("SELECT 1 AS ready").get().ready, 1); }
      finally { database.close(); }
    } else if (name.startsWith("@node-rs/argon2-")) {
      const nativeArgon2 = aliasRequire(name);
      assert.equal(await nativeArgon2.verify(await nativeArgon2.hash("hashed alias check"), "hashed alias check"), true);
    }
  }
}
console.log("Production runtime dependencies verified");
