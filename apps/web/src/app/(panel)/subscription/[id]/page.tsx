import { Suspense } from "react";
import { ResourceState } from "@/components/resource-state";
import { SubscriptionEditorPage } from "@/features/subscription/editor";
import { readOrNotFound } from "@/server/http/not-found";
import { requirePageUser } from "@/server/identity/queries";
import { getSubscriptionProfile } from "@/server/subscription/queries";

export default function Page({ params }: PageProps<"/subscription/[id]">) {
  return (
    <Suspense fallback={<ResourceState loading title="正在加载订阅…" />}>
      <SubscriptionEditorData params={params} />
    </Suspense>
  );
}

async function SubscriptionEditorData({ params }: Pick<PageProps<"/subscription/[id]">, "params">) {
  const [{ id }, me] = await Promise.all([params, requirePageUser()]);
  const profile = readOrNotFound(() => getSubscriptionProfile(me.principal, id));
  return <SubscriptionEditorPage profile={profile} />;
}
