import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactResponse } from "@/server/artifacts/download";

describe("public daemon artifacts", () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "bifurcation-artifacts-"));
    process.env.BIFURCATION_ARTIFACT_DIRECTORY = directory;
  });
  afterEach(() => { delete process.env.BIFURCATION_ARTIFACT_DIRECTORY; rmSync(directory, { recursive: true, force: true }); });

  it("streams only fixed artifact names and returns metadata for HEAD", async () => {
    const bytes = Buffer.alloc(512 * 1024, 0x3a);
    writeFileSync(join(directory, "daemon-linux-amd64"), bytes);
    const response = await artifactResponse("daemon-linux-amd64");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(bytes.length));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    const head = await artifactResponse("daemon-linux-amd64", true);
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(head.headers.get("content-length")).toBe(String(bytes.length));
  });
  it("rejects traversal, arbitrary files and directories without exposing their contents", async () => {
    writeFileSync(join(directory, "secret.txt"), "private");
    mkdirSync(join(directory, "daemon-linux-arm64"));
    for (const id of ["../secret.txt", "secret.txt", "daemon-linux-arm64", "daemon-linux-amd64/../secret.txt", "daemon-linux-amd64%2f..%2fsecret.txt"]) {
      const response = await artifactResponse(id);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("private");
    }
  });
});
