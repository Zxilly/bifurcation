import { MachineConfigurationPage } from "@/features/configuration/machine-configuration";
import { getMachineConfiguration } from "@/server/configuration/queries";
import { readOrNotFound } from "@/server/http/not-found";
import { requireAdminPageUser } from "@/server/identity/queries";
import { getMachine } from "@/server/modules/machines/queries";

export default async function ConfigurationPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, me] = await Promise.all([params, requireAdminPageUser()]);
  const machine = readOrNotFound(() => getMachine(me.principal, id));
  const configuration = getMachineConfiguration(me.principal, id);
  return <MachineConfigurationPage machine={machine} configuration={configuration} />;
}
