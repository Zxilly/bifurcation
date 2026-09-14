// Refreshes the vendored sing-box JSON Schema used by the configuration
// editors. Pin the typebox release that tracks the sing-box line the daemon
// embeds (services/daemon/go.mod), then run: node scripts/update-sing-box-schema.mjs
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const SCHEMA_RELEASE = "v1.14.31";
const source = `https://github.com/jiang-zhexin/typebox/releases/download/${SCHEMA_RELEASE}/schema.json`;
const target = fileURLToPath(new URL("../src/schemas/sing-box.json", import.meta.url));

const response = await fetch(source, { redirect: "follow" });
if (!response.ok) throw new Error(`${source}: HTTP ${response.status}`);
const schema = await response.json();
if (schema.$id !== "https://sing-box.sagernet.org/schema.json") throw new Error("Unexpected schema $id");
await writeFile(target, JSON.stringify(schema) + "\n");
console.log(`Wrote ${target} from ${SCHEMA_RELEASE}`);
