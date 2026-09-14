import { connection } from "next/server";
import { redirect } from "next/navigation";
import { needsSetup } from "@/server/identity/setup";
import { SetupForm } from "@/features/identity/setup-form";

export default async function Setup() {
  await connection();
  if (!needsSetup()) redirect("/");
  return <SetupForm />;
}
