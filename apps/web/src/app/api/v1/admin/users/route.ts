import { createUser, listUsers } from "@/server/users/service";
import { readJson, withApi } from "@/server/http/route";
export const GET = (request: Request) =>
  withApi(request, (principal) => ({ users: listUsers(principal) }), {
    admin: true,
  });
export const POST = (request: Request) =>
  withApi(
    request,
    async (principal) => createUser(principal, await readJson(request)),
    { admin: true },
  );
