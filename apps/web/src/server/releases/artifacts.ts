import "server-only";
import { readFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import { ArtifactSchema, type Artifact } from "@bifurcation/rpc";
import { z } from "zod";
import { artifactPath } from "@/server/artifacts/path";
import { getEnvironment } from "@/server/runtime/env";
import { AppError } from "@/server/http/errors";

const artifact = z.object({ filename: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), sizeBytes: z.number().int().positive().max(512 * 1024 * 1024) });
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/);
const manifestSchema = z.object({ version, bundledCoreVersion: version, protocolVersion: z.literal(1), artifacts: z.object({ amd64: artifact, arm64: artifact }) });
export interface DaemonRelease { artifact: Artifact; bundledCoreVersion: string }
export function getDaemonRelease(arch: string | null): DaemonRelease {
  if (arch !== "amd64" && arch !== "arm64") throw new AppError("UNSUPPORTED_ARCH", "daemon 制品仅支持 Linux amd64/arm64", 422);
  try {
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(/* turbopackIgnore: true */ artifactPath("daemon-manifest.json"), "utf8")));
    const entry = manifest.artifacts[arch];
    if (entry.filename !== `daemon-linux-${arch}`) throw new Error("unexpected artifact filename");
    return { artifact: create(ArtifactSchema, { id: `daemon-${manifest.version}-linux-${arch}`, version: manifest.version, os: "linux", arch, url: `${getEnvironment().publicUrl}/artifacts/${entry.filename}`, sha256: entry.sha256, sizeBytes: BigInt(entry.sizeBytes) }), bundledCoreVersion: manifest.bundledCoreVersion };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("DAEMON_ARTIFACT_NOT_READY", "daemon 制品尚未就绪或协议版本不兼容，请检查制品构建及 manifest", 503);
  }
}
