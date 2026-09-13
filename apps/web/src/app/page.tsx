import { redirect } from "next/navigation";
import { Role } from "@bifurcation/rpc/panel/types";
import { getCurrentUser } from "@/server/identity/queries";
export default async function Home() {
  const me = await getCurrentUser();
  redirect(
    me ? (me.user.role === Role.ADMIN ? "/admin" : "/overview") : "/login",
  );
}
