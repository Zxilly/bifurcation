import { Suspense } from "react";
import { ResourceState } from "@/components/resource-state";
import { Account } from "@/features/identity/account";
import { listApiKeys, listPasskeys } from "@/server/identity/account-queries";
import { requirePageUser } from "@/server/identity/queries";

export default function AccountPage() {
  return (
    <Suspense fallback={<ResourceState loading title="正在加载账号…" />}>
      <AccountData />
    </Suspense>
  );
}

async function AccountData() {
  const me = await requirePageUser();
  return (
    <Account
      apiKeys={listApiKeys(me.principal).apiKeys}
      passkeys={listPasskeys(me.principal).passkeys}
    />
  );
}
