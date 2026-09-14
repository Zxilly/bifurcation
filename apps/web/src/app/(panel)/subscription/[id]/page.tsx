import { SubscriptionEditorPage } from "@/features/subscription/editor";
import { readOrNotFound } from "@/server/http/not-found";
import { requirePageUser } from "@/server/identity/queries";
import { getSubscriptionProfile } from "@/server/subscription/queries";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, me] = await Promise.all([params, requirePageUser()]);
  const profile = readOrNotFound(() => getSubscriptionProfile(me.principal, id));
  return <SubscriptionEditorPage profile={profile} />;
}
