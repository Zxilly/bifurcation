import { updateUser } from "@/server/users/service";
import { readJson, withApi } from "@/server/http/route";
export const PATCH = (
  request: Request,
  context: { params: Promise<{ id: string }> },
) =>
  withApi(
    request,
    async (principal) =>
      updateUser(principal, (await context.params).id, await readJson(request)),
    { admin: true },
  );
