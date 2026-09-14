import { SubscriptionEditorPage } from "@/features/subscription/editor";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <SubscriptionEditorPage id={(await params).id} />;
}
