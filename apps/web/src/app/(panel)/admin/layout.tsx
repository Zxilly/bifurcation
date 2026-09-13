import { redirect } from "next/navigation";
import { requirePageUser } from "@/server/identity/queries";
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const me = await requirePageUser();
  if (me.user.role !== "admin") redirect("/overview");
  return children;
}
