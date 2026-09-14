import { redirect } from "next/navigation";
import { Role } from "@bifurcation/rpc/panel/types";
import { getCurrentUser } from "@/server/identity/queries";
import { needsSetup } from "@/server/identity/setup";
export default async function Home() {
  const me = await getCurrentUser();
  if (needsSetup()) redirect("/setup");
  redirect(
    me ? (me.user.role === Role.ADMIN ? "/admin" : "/overview") : "/login",
  );
}
