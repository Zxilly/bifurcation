import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/identity/queries";
import { LoginForm } from "@/features/identity/login-form";
import { needsSetup } from "@/server/identity/setup";
export default async function Login() {
  if (await getCurrentUser()) redirect("/");
  if (needsSetup()) redirect("/setup");
  return <LoginForm />;
}
