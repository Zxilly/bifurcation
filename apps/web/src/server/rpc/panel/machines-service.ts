import "server-only";
import type { ServiceImpl } from "@connectrpc/connect";
import { z } from "zod";
import { AdminMachineService } from "@bifurcation/rpc/panel/machines";
import { getDatabase } from "@/server/db";
import { ConfigurationStore } from "@/server/configuration/store";
import { MachineStore } from "@/server/modules/machines/store";
import { ReleaseStore } from "@/server/releases/store";
import { getMachine, getMachineUpgrades, listMachines } from "@/server/modules/machines/queries";
import { panelCall, requirePrincipal } from "./common";
import { taskHub } from "../task-hub";
import { toProtoMachineDetail, toProtoTask } from "./mappers";

const tagsInput = z.array(z.string().trim().min(1).max(32)).max(20).transform((tags) => [...new Set(tags)]);

const createInput = z.object({
  tags: tagsInput.default([]),
  name: z.string().trim().min(1).max(80),
  address: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9.:[\]-]+$/, "填写域名或 IP 地址"),
  region: z.string().trim().max(80).default(""),
});

const updateInput = z.object({
  tags: tagsInput.optional(),
  expectedVersion: z.number().int().positive(),
  name: z.string().trim().min(1).max(80).optional(),
  address: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9.:[\]-]+$/)
    .optional(),
  region: z.string().trim().max(80).optional(),
});

const rebindInput = z.object({ expectedVersion: z.number().int().positive() });

const inspectInput = z.object({
  requestKey: z.uuid(),
  includeLogs: z.boolean().default(false),
  maxLogLines: z.number().int().min(1).max(1000).default(100),
  maxBytes: z.number().int().min(1024).max(262144).default(262144),
});

export const machinesImplementation: ServiceImpl<typeof AdminMachineService> = {
  listMachines(_request, context) {
    return panelCall(() => listMachines(requirePrincipal(context)));
  },

  createMachine(request) {
    return panelCall(() => ({
      machine: toProtoMachineDetail(new MachineStore().create(createInput.parse(request))),
    }));
  },

  getMachine(request, context) {
    return panelCall(() => ({ machine: getMachine(requirePrincipal(context), request.machineId) }));
  },

  updateMachine(request) {
    return panelCall(() => {
      const input = updateInput.parse({
        expectedVersion: request.expectedVersion,
        name: request.name,
        address: request.address,
        region: request.region,
        tags: request.tags?.values,
      });
      return { machine: toProtoMachineDetail(new MachineStore().update(request.machineId, input)) };
    });
  },

  deleteMachine(request) {
    return panelCall(() => {
      new MachineStore().remove(request.machineId);
      taskHub.close(request.machineId);
      return { removed: true, localUninstallConfirmed: false };
    });
  },

  resetMachineToken(request) {
    return panelCall(() => {
      const store = new MachineStore();
      store.resetToken(request.machineId);
      taskHub.close(request.machineId);
      return { machine: toProtoMachineDetail(store.detail(request.machineId)) };
    });
  },

  rebindMachine(request) {
    return panelCall(() => {
      const { expectedVersion } = rebindInput.parse({ expectedVersion: request.expectedVersion });
      const handle = getDatabase();
      const machine = handle.db.transaction(() => {
        const rebound = new MachineStore(handle).rebind(request.machineId, expectedVersion);
        new ConfigurationStore(handle).markForRebind(request.machineId);
        return rebound;
      });
      taskHub.close(request.machineId);
      return { machine: toProtoMachineDetail(machine) };
    });
  },

  uninstallMachine(request) {
    return panelCall(() => ({
      task: toProtoTask(new ReleaseStore().uninstall(request.machineId, { requestKey: request.requestKey }).task),
    }));
  },

  listMachineTasks(request) {
    return panelCall(() => ({ tasks: new MachineStore().listTasks(request.machineId).map(toProtoTask) }));
  },

  enqueueInspectTask(request) {
    return panelCall(() => {
      const input = inspectInput.parse({
        requestKey: request.requestKey,
        includeLogs: request.includeLogs,
        maxLogLines: request.maxLogLines === 0 ? undefined : request.maxLogLines,
        maxBytes: request.maxBytes === 0 ? undefined : request.maxBytes,
      });
      const task = new MachineStore().enqueueInspect(request.machineId, input.requestKey, {
        includeLogs: input.includeLogs,
        maxLogLines: input.maxLogLines,
        maxBytes: input.maxBytes,
      });
      taskHub.wake(request.machineId);
      return { task: toProtoTask(task) };
    });
  },

  getMachineUpgrades(request, context) {
    return panelCall(() => ({ upgrades: getMachineUpgrades(requirePrincipal(context), request.machineId) }));
  },

  enqueueUpgrade(request) {
    return panelCall(() => ({
      task: toProtoTask(new ReleaseStore().enqueue(request.machineId, { expectedSha256: request.expectedSha256, requestKey: request.requestKey }).task),
    }));
  },
};
