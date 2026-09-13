import { MachineDetail } from "@/features/machines/machines";
export default async function MachinePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return <MachineDetail id={(await params).id} />;
}
