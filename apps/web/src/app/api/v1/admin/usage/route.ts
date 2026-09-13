import { withApi } from "@/server/http/route";
import { UsageStore } from "@/server/usage/store";
export const GET = (request: Request) =>
  withApi(
    request,
    () =>
      new UsageStore().query(
        Object.fromEntries(new URL(request.url).searchParams),
      ),
    { admin: true },
  );
