import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/identity/queries";
import { LoginForm } from "@/features/identity/login-form";
export default async function Login() {
  if (await getCurrentUser()) redirect("/");
  return <LoginForm />;
}
