import { withApi } from "@/server/http/route";
import { SubscriptionStore } from "@/server/subscription/store";
export const POST = (request: Request) =>
  withApi(request, (principal) =>
    new SubscriptionStore().resetToken(principal.user.id),
  );
