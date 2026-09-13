import { EnrollForm } from "@/features/identity/enroll-form";
export default async function Activate({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return <EnrollForm token={token ?? ""} recovery={false} />;
}
