import { EnrollForm } from "@/features/identity/enroll-form";
export default async function Recover({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return <EnrollForm token={token ?? ""} recovery />;
}
