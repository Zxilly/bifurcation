import "server-only";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";
import { getEnvironment } from "../runtime/env";

export function openDatabase(path: string, migrationsFolder = resolve(process.cwd(), "drizzle")) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  try {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder });
    return { db, sqlite };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
export type DatabaseHandle = ReturnType<typeof openDatabase>;
const globalDatabase = globalThis as typeof globalThis & { bifurcationDatabase?: DatabaseHandle };

export function getDatabase(): DatabaseHandle {
  return globalDatabase.bifurcationDatabase ??= openDatabase(getEnvironment().databasePath);
}
