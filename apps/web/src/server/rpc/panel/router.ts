import "server-only";
import { createConnectRouter } from "@connectrpc/connect";
import { AuthService } from "@bifurcation/rpc/panel/auth";
import { MeService } from "@bifurcation/rpc/panel/me";
import { AdminMachineService } from "@bifurcation/rpc/panel/machines";
import { AdminConfigurationService } from "@bifurcation/rpc/panel/configuration";
import { AdminUserService } from "@bifurcation/rpc/panel/users";
import { UsageService } from "@bifurcation/rpc/panel/usage";
import { authImplementation } from "./auth-service";
import { meImplementation } from "./me-service";
import { machinesImplementation } from "./machines-service";
import { configurationImplementation } from "./configuration-service";
import { usersImplementation } from "./users-service";
import { usageImplementation } from "./usage-service";
import { panelGate } from "./common";

// Panel API for the web console and API Key automation. Session cookies
// ride the same Connect endpoint; authorization tiers live in common.ts.
export function createPanelRouter() {
  const router = createConnectRouter({
    grpc: false,
    grpcWeb: false,
    // Configuration previews carry full sing-box documents.
    readMaxBytes: 4 * 1024 * 1024,
    writeMaxBytes: 8 * 1024 * 1024,
    requestGate: panelGate,
  });
  router.service(AuthService, authImplementation);
  router.service(MeService, meImplementation);
  router.service(AdminMachineService, machinesImplementation);
  router.service(AdminConfigurationService, configurationImplementation);
  router.service(AdminUserService, usersImplementation);
  router.service(UsageService, usageImplementation);
  return router;
}
