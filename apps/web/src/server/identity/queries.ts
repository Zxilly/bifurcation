import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Authentication } from "@bifurcation/rpc/panel/me";
import { Role } from "@bifurcation/rpc/panel/types";
import { authenticate, type Principal } from "./service";
import { AppError } from "../http/errors";
import { authentications, toProtoUser } from "../rpc/panel/mappers";

export type CurrentUser = {
  user: ReturnType<typeof toProtoUser>;
  authentication: Authentication;
  recentAuthentication: boolean;
  // Server-side only: pass to queries, never to Client Components.
  principal: Principal;
};

// Memoized per request so the panel layout, admin layout and page share one
// session lookup instead of repeating it at every segment.
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  // Resolve request state before environment/database access so prerendering can bail out.
  const requestHeaders = await headers();
  try {
    const principal = authenticate(requestHeaders);
    return {
      user: toProtoUser(principal.user),
      authentication: authentications[principal.authentication],
      recentAuthentication: principal.recentAuthentication,
      principal,
    };
  } catch (error) {
    if (error instanceof AppError && error.status === 401) return null;
    throw error;
  }
});
export async function requirePageUser(): Promise<CurrentUser> {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  return me;
}
export async function requireAdminPageUser(): Promise<CurrentUser> {
  const me = await requirePageUser();
  if (me.user.role !== Role.ADMIN) redirect("/overview");
  return me;
}
