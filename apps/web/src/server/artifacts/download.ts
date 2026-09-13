import "server-only";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { artifactDirectory, artifactPath } from "./path";

const artifactIds = new Set([
  "daemon-linux-amd64", "daemon-linux-amd64.sha256",
  "daemon-linux-arm64", "daemon-linux-arm64.sha256",
  "daemon-manifest.json",
]);

export async function artifactResponse(artifactId: string, head = false): Promise<Response> {
  if (!artifactIds.has(artifactId)) return new Response("Artifact not found\n", { status: 404 });
  let file;
  try {
    const directory = await realpath(/* turbopackIgnore: true */ artifactDirectory());
    const path = artifactPath(artifactId, directory);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile() || dirname(await realpath(path)) !== directory) return new Response("Artifact not found\n", { status: 404 });
    file = await open(path, "r");
    const opened = await file.stat();
    if (!opened.isFile() || opened.ino !== metadata.ino || opened.dev !== metadata.dev) {
      await file.close(); return new Response("Artifact changed; retry download\n", { status: 503 });
    }
    const headers = {
      "Content-Type": artifactId.endsWith(".sha256") ? "text/plain; charset=utf-8" : artifactId.endsWith(".json") ? "application/json; charset=utf-8" : "application/octet-stream",
      "Content-Length": String(opened.size),
      "Content-Disposition": `attachment; filename="${artifactId}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    if (head) { await file.close(); return new Response(null, { headers }); }
    return new Response(Readable.toWeb(file.createReadStream()) as ReadableStream<Uint8Array>, { headers });
  } catch (error) {
    await file?.close().catch(() => {});
    if (error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code))) return new Response("Artifact not available\n", { status: 404 });
    console.error("Artifact download failed", error);
    return new Response("Artifact unavailable\n", { status: 503 });
  }
}
