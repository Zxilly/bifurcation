import { Suspense } from "react";
import { SWRConfig } from "swr";
import { ResourceState } from "@/components/resource-state";
import { PersonalOverview } from "@/features/usage/overview";
import { snapshot } from "@/features/shared/snapshot";
import { initialUsageRanges, usageKey } from "@/features/usage/range";
import { requirePageUser } from "@/server/identity/queries";
import { getMyUsage } from "@/server/usage/queries";

export default function OverviewPage() {
  return (
    <Suspense fallback={<ResourceState loading title="正在加载用量…" />}>
      <OverviewData />
    </Suspense>
  );
}

async function OverviewData() {
  const me = await requirePageUser();
  const { month: monthRange, today: todayRange } = initialUsageRanges();
  return (
    <SWRConfig
      value={{
        fallback: {
          [usageKey(monthRange)]: snapshot(() => getMyUsage(me.principal, monthRange)),
          [usageKey(todayRange, "today")]: snapshot(() => getMyUsage(me.principal, todayRange)),
        },
      }}
    >
      <PersonalOverview />
    </SWRConfig>
  );
}
