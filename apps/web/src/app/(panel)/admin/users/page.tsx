import { Suspense } from "react";
import { SWRConfig } from "swr";
import { ResourceState } from "@/components/resource-state";
import { Users } from "@/features/users/users";
import { snapshot } from "@/features/shared/snapshot";
import { initialUsageRanges, usageKey } from "@/features/usage/range";
import { requireAdminPageUser } from "@/server/identity/queries";
import { queryUsage } from "@/server/usage/queries";
import { listUsers } from "@/server/users/queries";
export default async function UsersPage() {
  const me = await requireAdminPageUser();
  const range = initialUsageRanges().month;
  return (
    <SWRConfig
      value={{
        fallback: {
          [usageKey(range, "admin")]: snapshot(() => queryUsage(me.principal, range)),
        },
      }}
    >
      <Suspense fallback={<ResourceState loading title="正在加载用户…" />}>
        <Users users={listUsers(me.principal).users} />
      </Suspense>
    </SWRConfig>
  );
}
