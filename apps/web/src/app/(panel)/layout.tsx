import { Suspense } from "react";
import { Role } from "@bifurcation/rpc/panel/types";
import { AdminNavigation, AppShell } from "@/components/app-shell";
import { requirePageUser } from "@/server/identity/queries";

// The layout stays synchronous so the shell streams before the session
// lookup finishes; only the parts that depend on the account suspend.
export default function PanelLayout({ children }: LayoutProps<"/">) {
  return (
    <AppShell
      identity={
        <Suspense fallback={<span className="max-w-32 sm:max-w-none" aria-hidden />}>
          <Identity />
        </Suspense>
      }
      adminNavigation={
        <Suspense fallback={null}>
          <AdminNavigationGate />
        </Suspense>
      }
    >
      {children}
    </AppShell>
  );
}

async function Identity() {
  const me = await requirePageUser();
  return (
    <span className="max-w-32 truncate sm:max-w-none" title={me.user.username}>
      {me.user.username}
    </span>
  );
}

async function AdminNavigationGate() {
  const me = await requirePageUser();
  return me.user.role === Role.ADMIN ? <AdminNavigation /> : null;
}
