import "server-only";
import { resolve } from "node:path";

// Deployment supplies this directory explicitly. It must never be expanded by
// the bundler into a trace of the developer's project or private runtime data.
export function artifactDirectory() {
  return resolve(/* turbopackIgnore: true */ process.env.BIFURCATION_ARTIFACT_DIRECTORY ?? "../../artifacts");
}
export function artifactPath(filename: string, directory = artifactDirectory()) {
  return resolve(/* turbopackIgnore: true */ directory, filename);
}
