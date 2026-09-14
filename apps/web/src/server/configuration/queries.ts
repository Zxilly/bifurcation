import "server-only";
import { cache } from "react";
import { create } from "@bufbuild/protobuf";
import { MachineConfigurationSchema } from "@bifurcation/rpc/panel/configuration";
import { requireAdmin, type Principal } from "@/server/identity/service";
import { toProtoConfiguration } from "@/server/rpc/panel/mappers";
import { ConfigurationStore } from "./store";

// Administrator read shared by the configuration pages and AdminConfigurationService.
export const getMachineConfiguration = cache((principal: Principal, machineId: string) => {
  requireAdmin(principal);
  return create(MachineConfigurationSchema, toProtoConfiguration(new ConfigurationStore().get(machineId)));
});
