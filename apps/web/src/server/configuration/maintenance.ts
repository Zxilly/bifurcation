import "server-only";
import { lte } from "drizzle-orm";
import { getDatabase } from "@/server/db";
import { configPreviews } from "@/server/db/schema-proxy";
import { UsageStore } from "@/server/usage/store";
import { ConfigurationStore } from "./store";

const runtime = globalThis as typeof globalThis & { bifurcationProxyMaintenance?: ReturnType<typeof setInterval> };
export function startProxyMaintenance() {
  if (runtime.bifurcationProxyMaintenance) return;
  let lastCleanup = 0;
  const reconcile = () => {
    try {
      new ConfigurationStore().reconcile();
      if (Date.now() - lastCleanup > 60_000) {
        new UsageStore().cleanMinutes();
        // Keep published previews for one day so retries can recover their exact task.
        getDatabase().db.delete(configPreviews).where(lte(configPreviews.expiresAt, Date.now() - 24 * 60 * 60_000)).run();
        lastCleanup = Date.now();
      }
    } catch (error) { console.error("Proxy policy reconciliation failed", error); }
  };
  reconcile();
  runtime.bifurcationProxyMaintenance = setInterval(reconcile, 5000);
  runtime.bifurcationProxyMaintenance.unref();
}
export function stopProxyMaintenance() {
  if (runtime.bifurcationProxyMaintenance) clearInterval(runtime.bifurcationProxyMaintenance);
  delete runtime.bifurcationProxyMaintenance;
}
