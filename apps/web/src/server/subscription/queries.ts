import "server-only";
import { cache } from "react";
import { create } from "@bufbuild/protobuf";
import { ListSubscriptionProfilesResponseSchema, SubscriptionProfileSchema } from "@bifurcation/rpc/panel/me";
import type { Principal } from "@/server/identity/service";
import { toProtoSubscription } from "@/server/rpc/panel/mappers";
import { SubscriptionProfileStore } from "./profiles";
import { SubscriptionStore } from "./store";

// Account-scoped reads shared by the subscription pages and MeService.
export const listSubscriptionProfiles = cache((principal: Principal) => {
  const userId = principal.user.id;
  return create(ListSubscriptionProfilesResponseSchema, {
    profiles: new SubscriptionProfileStore().list(userId),
    context: toProtoSubscription({ ...new SubscriptionStore().get(userId), url: "", configJson: "" }),
  });
});

export const getSubscriptionProfile = cache((principal: Principal, id: string) =>
  create(SubscriptionProfileSchema, new SubscriptionProfileStore().get(principal.user.id, id)),
);
