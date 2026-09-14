import { MachineConfigurationPage } from "@/features/configuration/machine-configuration";

export default async function ConfigurationPage({ params }: { params: Promise<{ id: string }> }) {
  return <MachineConfigurationPage id={(await params).id} />;
}
