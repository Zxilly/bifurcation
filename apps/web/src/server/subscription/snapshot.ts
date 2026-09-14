import "server-only";
import { and, asc, eq, isNull } from "drizzle-orm";
import { fromJsonString } from "@bufbuild/protobuf";
import { CoreHealth, MachineStatusSchema } from "@bifurcation/rpc";
import type { MachineConfigurationInput } from "@/contracts/configuration";
import { getDatabase, type DatabaseHandle } from "@/server/db";
import { configRevisions, machineConfigs, policyState } from "@/server/db/schema-proxy";
import { machines } from "@/server/db/schema-machines";
import { decryptSecret } from "@/server/crypto";
import { userQuota } from "@/server/configuration/policy";
import { readProxyCredentials } from "./credentials";
import { MachineStore } from "@/server/modules/machines/store";

export function subscriptionSnapshot(userId: string, handle: DatabaseHandle = getDatabase()) {
    const credentials = readProxyCredentials(userId, handle);
    const quota = userQuota(userId, handle);
    const blocked = quota.user.status !== "active" || quota.blocked;
    const latestPolicy = handle.db.select().from(policyState).where(eq(policyState.id, "global")).get()?.revision ?? 0;
    const records = handle.db.select({ machine: machines, configuration: machineConfigs }).from(machineConfigs).innerJoin(machines, eq(machineConfigs.machineId, machines.id))
      .where(isNull(machines.removedAt)).orderBy(asc(machines.name), asc(machines.id)).all().filter(({ machine, configuration }) => !!configuration.settingsCiphertext && !!configuration.desiredRevisionId && !new MachineStore(handle).isUninstalled(machine.id, machine.bindingEpoch));
    const nodes = records.map(({ machine, configuration }) => {
      const status = machine.statusJson ? fromJsonString(MachineStatusSchema, machine.statusJson) : undefined;
      const effective = status?.appliedRevisionId ? handle.db.select().from(configRevisions).where(and(eq(configRevisions.id, status.appliedRevisionId), eq(configRevisions.machineId, machine.id))).get() : undefined;
      const authorizationCurrent = !!status && status.appliedPolicyRevision >= BigInt(Math.max(configuration.desiredPolicyRevision, latestPolicy));
      const available = !!effective && status?.coreHealth === CoreHealth.HEALTHY && authorizationCurrent;
      return { id: machine.id, name: machine.name, address: machine.address, region: machine.region, tags: machine.tags, settings: JSON.parse(decryptSecret(effective?.settingsCiphertext ?? configuration.settingsCiphertext!)) as MachineConfigurationInput, available, applied: status?.appliedRevisionId === configuration.desiredRevisionId && authorizationCurrent };
    });
    return { credentials, quota, blocked, nodes };
}
