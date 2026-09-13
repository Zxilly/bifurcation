import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const buf = ["node_modules/@bufbuild/buf/bin/buf"];

// TypeScript: every proto (daemon stream + panel API). Go: the daemon
// protocol only; the panel API has no Go consumers.
const steps = [
  ["generate"],
  ["generate", "--template", "buf.gen.go.yaml", "--path", "proto/bifurcation/v1"],
];
for (const args of steps) {
  const result = spawnSync(process.execPath, [...buf, ...args], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
