export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    const { getDatabase } = await import("./server/db");
    getDatabase();
    const { startIdentityMaintenance } = await import("./server/runtime/lifecycle");
    startIdentityMaintenance();
    const { startProxyMaintenance } = await import("./server/configuration/maintenance");
    startProxyMaintenance();
  }
}
