import "server-only";
import { lte } from "drizzle-orm";
import { getDatabase } from "../db";
import { authFlows, rateLimits, sessions } from "../db/schema";
import { taskHub } from "../rpc/task-hub";
import { stopProxyMaintenance } from "../configuration/maintenance";

const runtime = globalThis as typeof globalThis & {
  bifurcationIdentityMaintenance?: ReturnType<typeof setInterval>;
  bifurcationShutdownRegistered?: boolean;
};

function stopRuntime() {
  if (runtime.bifurcationIdentityMaintenance) clearInterval(runtime.bifurcationIdentityMaintenance);
  runtime.bifurcationIdentityMaintenance = undefined;
  stopProxyMaintenance();
  // End long-lived responses so Next can drain normally. SQLite remains open
  // for any already-authorized in-flight request until the process exits.
  taskHub.shutdown();
}
function cleanExpiredIdentityState(now = Date.now()) {
  const { db } = getDatabase();
  db.transaction((tx) => {
    tx.delete(authFlows).where(lte(authFlows.expiresAt, now)).run();
    tx.delete(sessions).where(lte(sessions.expiresAt, now)).run();
    tx.delete(rateLimits).where(lte(rateLimits.resetsAt, now)).run();
  });
}
export function startIdentityMaintenance() {
  if (runtime.bifurcationIdentityMaintenance) return;
  cleanExpiredIdentityState();
  runtime.bifurcationIdentityMaintenance = setInterval(() => {
    try { cleanExpiredIdentityState(); }
    catch (error) { console.error("Identity maintenance failed", error); }
  }, 60_000);
  runtime.bifurcationIdentityMaintenance.unref();
  if (!runtime.bifurcationShutdownRegistered) {
    process.once("SIGTERM", stopRuntime);
    process.once("SIGINT", stopRuntime);
    runtime.bifurcationShutdownRegistered = true;
  }
}
