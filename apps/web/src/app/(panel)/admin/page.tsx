import { Suspense } from "react";
import { SWRConfig } from "swr";
import { ResourceState } from "@/components/resource-state";
import { AdminUsageOverview } from "@/features/usage/overview";
import { resourceKeys } from "@/features/shared/keys";
import { snapshot } from "@/features/shared/snapshot";
import { initialUsageRanges, usageKey } from "@/features/usage/range";
import { requireAdminPageUser } from "@/server/identity/queries";
import { listMachines } from "@/server/modules/machines/queries";
import { queryUsage } from "@/server/usage/queries";
import { listUsers } from "@/server/users/queries";

export default function AdminPage() {
  return (
    <Suspense fallback={<ResourceState loading title="正在加载概览…" />}>
      <AdminData />
    </Suspense>
  );
}

async function AdminData() {
  const me = await requireAdminPageUser();
  const range = initialUsageRanges().month;
  return (
    <SWRConfig
      value={{
        fallback: {
          [usageKey(range, "admin")]: snapshot(() => queryUsage(me.principal, range)),
          [resourceKeys.machines]: snapshot(() => listMachines(me.principal)),
          [resourceKeys.users]: snapshot(() => listUsers(me.principal)),
        },
      }}
    >
      <AdminUsageOverview />
    </SWRConfig>
  );
}
