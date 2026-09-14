import { Suspense } from "react";
import { ResourceState } from "@/components/resource-state";
import { Subscription } from "@/features/subscription/subscription";
import { requirePageUser } from "@/server/identity/queries";
import { listSubscriptionProfiles } from "@/server/subscription/queries";

export default function SubscriptionPage() {
  return (
    <Suspense fallback={<ResourceState loading title="正在加载订阅…" />}>
      <SubscriptionData />
    </Suspense>
  );
}

async function SubscriptionData() {
  const me = await requirePageUser();
  const { profiles, context } = listSubscriptionProfiles(me.principal);
  return <Subscription profiles={profiles} context={context} />;
}
