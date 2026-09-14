import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDatabase, type DatabaseHandle } from "@/server/db";
import { users } from "@/server/db/schema";
import { newId } from "@/server/crypto";
import { userDto, type Principal } from "@/server/identity/service";
import { listApiKeys } from "@/server/identity/account-queries";
import { readOrNotFound } from "@/server/http/not-found";
import { MachineStore } from "@/server/modules/machines/store";
import { getMachine, listMachines } from "@/server/modules/machines/queries";
import { listUsers } from "@/server/users/queries";

const globals = globalThis as typeof globalThis & { bifurcationDatabase?: DatabaseHandle };
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "bifurcation-page-queries-"));
  process.env.BIFURCATION_DATABASE_PATH = join(directory, "panel.sqlite");
  process.env.BIFURCATION_PUBLIC_URL = "http://localhost:3000";
  process.env.BIFURCATION_APP_KEY = "ab".repeat(32);
});
afterEach(() => { globals.bifurcationDatabase?.sqlite.close(); delete globals.bifurcationDatabase; rmSync(directory, { recursive: true, force: true }); });

function principal(role: "admin" | "user"): Principal {
  const row = { id: newId(), username: role, role, status: "active" as const, version: 1, monthlyLimitBytes: null, createdAt: Date.now() };
  getDatabase().db.insert(users).values(row).run();
  return { user: userDto(row), authentication: "session", recentAuthentication: true };
}

// Pages call these reads directly, so they must carry the same authorization
// floor as the RPC tier table and hand Client Components complete messages.
describe("page query boundary", () => {
  it("refuses administrator reads for regular accounts", () => {
    const user = principal("user");
    expect(() => listMachines(user)).toThrow(expect.objectContaining({ code: "FORBIDDEN", status: 403 }));
    expect(() => listUsers(user)).toThrow(expect.objectContaining({ code: "FORBIDDEN", status: 403 }));
  });

  it("returns materialized protobuf messages for administrators", () => {
    const admin = principal("admin");
    const created = new MachineStore().create({ name: "node-a", address: "node-a.example", region: "", tags: [] });
    const list = listMachines(admin);
    expect(list.$typeName).toBe("bifurcation.panel.v1.ListMachinesResponse");
    expect(list.machines.map((machine) => machine.id)).toEqual([created.id]);
    const machine = getMachine(admin, created.id);
    expect(machine.$typeName).toBe("bifurcation.panel.v1.MachineDetail");
    expect(machine.tasks).toEqual([]);
    expect(machine.createdAt).toBeTypeOf("bigint");
    expect(listApiKeys(admin)).toMatchObject({ $typeName: "bifurcation.panel.v1.ListApiKeysResponse", apiKeys: [] });
  });

  it("maps a missing resource to the segment not-found page and leaves other failures alone", () => {
    const admin = principal("admin");
    expect(() => readOrNotFound(() => getMachine(admin, "missing"))).toThrow(
      expect.objectContaining({ digest: expect.stringContaining("404") }),
    );
    expect(() => readOrNotFound(() => listMachines(principal("user")))).toThrow(
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  });
});
