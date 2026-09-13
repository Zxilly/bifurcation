import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/identity/queries";
export default async function Home() {
  const me = await getCurrentUser();
  redirect(me ? (me.user.role === "admin" ? "/admin" : "/overview") : "/login");
}
