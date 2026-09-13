import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Authentication } from "@bifurcation/rpc/panel/me";
import { authenticate } from "./service";
import { AppError } from "../http/errors";
import { authentications, toProtoUser } from "../rpc/panel/mappers";

export type CurrentUser = {
  user: ReturnType<typeof toProtoUser>;
  authentication: Authentication;
  recentAuthentication: boolean;
};

export async function getCurrentUser(): Promise<CurrentUser | null> {
  // Resolve request state before environment/database access so prerendering can bail out.
  const requestHeaders = await headers();
  try {
    const principal = authenticate(requestHeaders);
    return {
      user: toProtoUser(principal.user),
      authentication: authentications[principal.authentication],
      recentAuthentication: principal.recentAuthentication,
    };
  } catch (error) {
    if (error instanceof AppError && error.status === 401) return null;
    throw error;
  }
}
export async function requirePageUser(): Promise<CurrentUser> {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  return me;
}
