import { Suspense } from "react";
import { SWRConfig } from "swr";
import { ResourceState } from "@/components/resource-state";
import { Machines } from "@/features/machines/machines";
import { resourceKeys } from "@/features/shared/keys";
import { snapshot } from "@/features/shared/snapshot";
import { requireAdminPageUser } from "@/server/identity/queries";
import { listMachines } from "@/server/modules/machines/queries";

export default function MachinesPage() {
  return (
    <Suspense fallback={<ResourceState loading title="正在加载机器…" />}>
      <MachinesData />
    </Suspense>
  );
}

async function MachinesData() {
  const me = await requireAdminPageUser();
  return (
    <SWRConfig
      value={{
        fallback: {
          [resourceKeys.machines]: snapshot(() => listMachines(me.principal)),
        },
      }}
    >
      <Machines />
    </SWRConfig>
  );
}
