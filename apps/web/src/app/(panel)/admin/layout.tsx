import { requireAdminPageUser } from "@/server/identity/queries";
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAdminPageUser();
  return children;
}
