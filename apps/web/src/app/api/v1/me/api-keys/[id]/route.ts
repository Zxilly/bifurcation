import { revokeApiKey } from "@/server/identity/service";
import { withApi } from "@/server/http/route";
export const DELETE = (
  request: Request,
  context: { params: Promise<{ id: string }> },
) =>
  withApi(request, async (principal) =>
    revokeApiKey(principal, (await context.params).id),
  );
