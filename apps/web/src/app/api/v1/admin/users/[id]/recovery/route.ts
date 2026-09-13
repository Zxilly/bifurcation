import { createUserFlow } from "@/server/users/service";
import { withApi } from "@/server/http/route";
export const POST = (
  request: Request,
  context: { params: Promise<{ id: string }> },
) =>
  withApi(
    request,
    async (principal) =>
      createUserFlow(principal, (await context.params).id, "recovery"),
    { admin: true },
  );
