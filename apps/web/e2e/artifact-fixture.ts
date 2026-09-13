import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Inert payloads exercise the panel's manifest/SHA contract only. The protocol
// peer never executes them; real daemon artifact execution has separate tests.
export async function createArtifactFixture(directory: string) {
  await mkdir(directory);
  async function entry(filename: string) {
    const bytes = Buffer.concat([
      Buffer.from("bifurcation browser-test artifact\n"),
      randomBytes(64),
    ]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(directory, filename), bytes);
    await writeFile(
      join(directory, `${filename}.sha256`),
      `${sha256}  ${filename}\n`,
    );
    return { filename, sha256, sizeBytes: bytes.length };
  }
  async function replaceDaemonArtifact() {
    await writeFile(
      join(directory, "daemon-manifest.json"),
      JSON.stringify({
        version: "0.2.0",
        bundledCoreVersion: "1.14.0",
        protocolVersion: 1,
        artifacts: {
          amd64: await entry("daemon-linux-amd64"),
          arm64: await entry("daemon-linux-arm64"),
        },
      }),
    );
  }
  await replaceDaemonArtifact();
  return { replaceDaemonArtifact };
}
