import "server-only";
import type { ServiceImpl } from "@connectrpc/connect";
import { UsageService } from "@bifurcation/rpc/panel/usage";
import { queryUsage } from "@/server/usage/queries";
import { panelCall, requirePrincipal } from "./common";
import { grainNames } from "./mappers";

export const usageImplementation: ServiceImpl<typeof UsageService> = {
  queryUsage(request, context) {
    return panelCall(() => ({
      usage: queryUsage(requirePrincipal(context), {
        start: request.start === undefined ? undefined : Number(request.start),
        end: request.end === undefined ? undefined : Number(request.end),
        grain: grainNames[request.grain],
        userId: request.userId,
        machineId: request.machineId,
      }),
    }));
  },
};
