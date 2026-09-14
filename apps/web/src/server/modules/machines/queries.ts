import "server-only";
import { cache } from "react";
import { create } from "@bufbuild/protobuf";
import {
  ListMachinesResponseSchema,
  MachineDetailSchema,
  MachineUpgradesSchema,
} from "@bifurcation/rpc/panel/machines";
import { requireAdmin, type Principal } from "@/server/identity/service";
import { ReleaseStore } from "@/server/releases/store";
import { toProtoMachine, toProtoMachineDetail, toProtoMachineUpgrades } from "@/server/rpc/panel/mappers";
import { MachineStore } from "./store";

// Administrator reads shared by the machine pages and AdminMachineService.
// Authorization is enforced here so pages and RPC keep the same floor.
export const listMachines = cache((principal: Principal) => {
  requireAdmin(principal);
  return create(ListMachinesResponseSchema, { machines: new MachineStore().list().map(toProtoMachine) });
});

export const getMachine = cache((principal: Principal, machineId: string) => {
  requireAdmin(principal);
  return create(MachineDetailSchema, toProtoMachineDetail(new MachineStore().detail(machineId)));
});

export const getMachineUpgrades = cache((principal: Principal, machineId: string) => {
  requireAdmin(principal);
  return create(MachineUpgradesSchema, toProtoMachineUpgrades(new ReleaseStore().get(machineId)));
});
