import { ConnectError, createClient, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { AuthService } from "@bifurcation/rpc/panel/auth";
import { MeService } from "@bifurcation/rpc/panel/me";
import { AdminMachineService } from "@bifurcation/rpc/panel/machines";
import { AdminConfigurationService } from "@bifurcation/rpc/panel/configuration";
import { AdminUserService } from "@bifurcation/rpc/panel/users";
import { UsageService } from "@bifurcation/rpc/panel/usage";
import { ErrorDetailSchema } from "@bifurcation/rpc/panel/types";
import { ApiError } from "./api";

export function panelTransport(transport: Transport): Transport {
  return {
    ...transport,
    async unary(...args) {
      try {
        return await transport.unary(...args);
      } catch (error) {
        if (error instanceof ConnectError) {
          const detail = error.findDetails(ErrorDetailSchema)[0];
          throw new ApiError(
            detail?.code ?? "request_failed",
            error.rawMessage || "请求失败，请重试。",
            detail?.requestId,
            detail?.fields
              ? Object.fromEntries(
                  Object.entries(detail.fields).map(([key, value]) => [key, value.messages]),
                )
              : undefined,
            error.code,
          );
        }
        throw error;
      }
    },
  };
}

// Map after the transport completes: Connect normalizes errors thrown by
// interceptors back into ConnectError and would lose our application code.
const transport = panelTransport(createConnectTransport({
  baseUrl: "/rpc",
  useBinaryFormat: false,
}));

export const panel = {
  auth: createClient(AuthService, transport),
  me: createClient(MeService, transport),
  machines: createClient(AdminMachineService, transport),
  configuration: createClient(AdminConfigurationService, transport),
  users: createClient(AdminUserService, transport),
  usage: createClient(UsageService, transport),
};
