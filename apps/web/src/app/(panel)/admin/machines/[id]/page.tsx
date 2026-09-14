import { Suspense } from "react";
import { SWRConfig } from "swr";
import { ResourceState } from "@/components/resource-state";
import { MachineDetailPage } from "@/features/machines/machines";
import { resourceKeys } from "@/features/shared/keys";
import { snapshot } from "@/features/shared/snapshot";
import { initialUsageRanges, usageKey } from "@/features/usage/range";
import { getMachineConfiguration } from "@/server/configuration/queries";
import { readOrNotFound } from "@/server/http/not-found";
import { requireAdminPageUser } from "@/server/identity/queries";
import { getMachine, getMachineUpgrades } from "@/server/modules/machines/queries";
import { queryUsage } from "@/server/usage/queries";

export default async function MachinePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ id }, { tab }, me] = await Promise.all([params, searchParams, requireAdminPageUser()]);
  const machine = readOrNotFound(() => getMachine(me.principal, id));
  const range = initialUsageRanges().month;
  // Only the visible tab is prefetched; the others load when selected.
  const fallback: Record<string, Promise<unknown>> = {
    [resourceKeys.machine(id)]: snapshot(() => machine),
  };
  if (tab === "usage") {
    fallback[usageKey(range, `machine:${id}`)] = snapshot(
      () => queryUsage(me.principal, { ...range, machineId: id }),
    );
  } else if (tab === "maintenance") {
    if (machine.installationId && !machine.uninstalled)
      fallback[resourceKeys.machineUpgrades(id)] = snapshot(
        () => getMachineUpgrades(me.principal, id),
      );
  } else if (!machine.uninstalled) {
    fallback[resourceKeys.machineConfiguration(id)] = snapshot(
      () => getMachineConfiguration(me.principal, id),
    );
  }
  return (
    <SWRConfig value={{ fallback }}>
      <Suspense fallback={<ResourceState loading title="正在加载机器…" />}>
        <MachineDetailPage id={id} />
      </Suspense>
    </SWRConfig>
  );
}
