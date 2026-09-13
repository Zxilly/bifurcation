import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { MeDto } from "@/contracts/identity";
import { authenticate } from "./service";
import { AppError } from "../http/errors";
import { getEnvironment } from "../runtime/env";

export async function getCurrentUser(): Promise<MeDto | null> {
  // Resolve request state before environment/database access so prerendering can bail out.
  const requestHeaders = await headers();
  try {
    const principal = authenticate(new Request(getEnvironment().publicUrl, { headers: requestHeaders }));
    return { user: principal.user, authentication: principal.authentication, recentAuthentication: principal.recentAuthentication };
  } catch (error) {
    if (error instanceof AppError && error.status === 401) return null;
    throw error;
  }
}
export async function requirePageUser(): Promise<MeDto> {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  return me;
}
