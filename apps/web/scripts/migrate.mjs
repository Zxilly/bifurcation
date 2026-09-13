import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

const path = resolve(process.env.BIFURCATION_DATABASE_PATH ?? "./data/bifurcation.sqlite");
mkdirSync(dirname(path), { recursive: true });
const sqlite = new Database(path);
try {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  migrate(drizzle(sqlite), { migrationsFolder: resolve(import.meta.dirname, "../drizzle") });
  console.log("Database migrations complete");
} finally { sqlite.close(); }
