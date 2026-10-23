import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type DatabaseHandle } from "@/server/db";

describe("panel database durability", () => {
  let directory: string;
  const handles: DatabaseHandle[] = [];

  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "bifurcation-durability-")); });
  afterEach(() => {
    for (const handle of handles.splice(0)) handle.sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("requires durable WAL commits after migration and on every reopened connection", () => {
    const path = join(directory, "panel.sqlite");
    for (let attempt = 0; attempt < 2; attempt++) {
      const handle = openDatabase(path);
      handles.push(handle);
      // Check after schema access: SQLite can apply the compiled WAL default
      // lazily, so checking only immediately after opening misses the regression.
      const migrations = handle.sqlite.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get() as { count: number };
      expect(migrations.count).toBeGreaterThan(0);
      expect(handle.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(handle.sqlite.pragma("synchronous", { simple: true })).toBe(2);
      expect(handle.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
      handle.sqlite.close();
      handles.pop();
    }
  });
});
