import { Subscription } from "@/features/subscription/subscription";
import { requirePageUser } from "@/server/identity/queries";
import { listSubscriptionProfiles } from "@/server/subscription/queries";
export default async function SubscriptionPage() {
  const me = await requirePageUser();
  const { profiles, context } = listSubscriptionProfiles(me.principal);
  return <Subscription profiles={profiles} context={context} />;
}
