import { redirect } from "next/navigation";
import { Role } from "@bifurcation/rpc/panel/types";
import { requirePageUser } from "@/server/identity/queries";
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const me = await requirePageUser();
  if (me.user.role !== Role.ADMIN) redirect("/overview");
  return children;
}
