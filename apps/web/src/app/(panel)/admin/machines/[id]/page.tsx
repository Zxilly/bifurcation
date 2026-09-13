import { MachineDetailPage } from "@/features/machines/machines";
export default async function MachinePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return <MachineDetailPage id={(await params).id} />;
}
