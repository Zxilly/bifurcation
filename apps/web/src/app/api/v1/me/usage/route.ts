import { withApi } from "@/server/http/route";
import { UsageStore } from "@/server/usage/store";
export const GET = (request: Request) =>
  withApi(request, (principal) =>
    new UsageStore().query({
      ...Object.fromEntries(new URL(request.url).searchParams),
      userId: principal.user.id,
    }),
  );
