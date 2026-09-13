import { withApi } from "@/server/http/route";
import { SubscriptionStore } from "@/server/subscription/store";
export const GET = (request: Request) =>
  withApi(request, (principal) =>
    new SubscriptionStore().get(principal.user.id),
  );
