import { withApi } from "@/server/http/route";
import { SubscriptionStore } from "@/server/subscription/store";
export const GET = (request: Request) =>
  withApi(
    request,
    (principal) =>
      new Response(new SubscriptionStore().get(principal.user.id).configJson, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": 'attachment; filename="bifurcation.json"',
          "Cache-Control": "no-store",
        },
      }),
  );
