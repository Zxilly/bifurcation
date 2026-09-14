import { Suspense } from "react";
import { ResourceState } from "@/components/resource-state";
import { MachineConfigurationPage } from "@/features/configuration/machine-configuration";
import { getMachineConfiguration } from "@/server/configuration/queries";
import { readOrNotFound } from "@/server/http/not-found";
import { requireAdminPageUser } from "@/server/identity/queries";
import { getMachine } from "@/server/modules/machines/queries";

export default function ConfigurationPage({ params }: PageProps<"/admin/machines/[id]/configuration">) {
  return (
    <Suspense fallback={<ResourceState loading title="正在加载配置…" />}>
      <ConfigurationData params={params} />
    </Suspense>
  );
}

async function ConfigurationData({ params }: Pick<PageProps<"/admin/machines/[id]/configuration">, "params">) {
  const [{ id }, me] = await Promise.all([params, requireAdminPageUser()]);
  const machine = readOrNotFound(() => getMachine(me.principal, id));
  const configuration = getMachineConfiguration(me.principal, id);
  return <MachineConfigurationPage machine={machine} configuration={configuration} />;
}
