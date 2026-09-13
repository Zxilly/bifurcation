import { ConnectError, createClient, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { AuthService } from "@bifurcation/rpc/panel/auth";
import { MeService } from "@bifurcation/rpc/panel/me";
import { AdminMachineService } from "@bifurcation/rpc/panel/machines";
import { AdminConfigurationService } from "@bifurcation/rpc/panel/configuration";
import { AdminUserService } from "@bifurcation/rpc/panel/users";
import { UsageService } from "@bifurcation/rpc/panel/usage";
import { ErrorDetailSchema } from "@bifurcation/rpc/panel/types";
import { ApiError } from "./api";

// Surfaces every RPC failure as ApiError carrying the server's
// machine-readable code (ErrorDetail), so call sites keep their
// code === "REAUTH_REQUIRED" style handling.
const mapErrors: Interceptor = (next) => async (request) => {
  try {
    return await next(request);
  } catch (error) {
    if (error instanceof ConnectError) {
      const detail = error.findDetails(ErrorDetailSchema)[0];
      throw new ApiError(
        detail?.code ?? "request_failed",
        error.rawMessage || "请求失败，请重试。",
        detail?.requestId,
        detail?.fields
          ? Object.fromEntries(Object.entries(detail.fields).map(([key, value]) => [key, value.messages]))
          : undefined,
      );
    }
    throw error;
  }
};

const transport = createConnectTransport({
  baseUrl: "/rpc",
  useBinaryFormat: false,
  interceptors: [mapErrors],
});

export const panel = {
  auth: createClient(AuthService, transport),
  me: createClient(MeService, transport),
  machines: createClient(AdminMachineService, transport),
  configuration: createClient(AdminConfigurationService, transport),
  users: createClient(AdminUserService, transport),
  usage: createClient(UsageService, transport),
};
