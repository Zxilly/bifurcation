import { AppShell } from "@/components/app-shell";
import { requirePageUser } from "@/server/identity/queries";
export default async function PanelLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const me = await requirePageUser();
  return <AppShell user={me.user}>{children}</AppShell>;
}
