import { Account } from "@/features/identity/account";
import { listApiKeys, listPasskeys } from "@/server/identity/account-queries";
import { requirePageUser } from "@/server/identity/queries";
export default async function AccountPage() {
  const me = await requirePageUser();
  return (
    <Account
      apiKeys={listApiKeys(me.principal).apiKeys}
      passkeys={listPasskeys(me.principal).passkeys}
    />
  );
}
