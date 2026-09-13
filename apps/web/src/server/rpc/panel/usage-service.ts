import "server-only";
import type { ServiceImpl } from "@connectrpc/connect";
import { UsageService } from "@bifurcation/rpc/panel/usage";
import { UsageStore } from "@/server/usage/store";
import { panelCall } from "./common";
import { grainNames, toProtoUsage } from "./mappers";

export const usageImplementation: ServiceImpl<typeof UsageService> = {
  queryUsage(request) {
    return panelCall(() => {
      const usage = new UsageStore().query({
        start: request.start === undefined ? undefined : Number(request.start),
        end: request.end === undefined ? undefined : Number(request.end),
        grain: grainNames[request.grain],
        userId: request.userId,
        machineId: request.machineId,
      });
      return { usage: toProtoUsage(usage) };
    });
  },
};
