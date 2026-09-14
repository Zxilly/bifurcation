"use client";

import { Button, Banner, Sidebar } from "@cloudflare/kumo";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { useSidebar } from "@cloudflare/kumo/components/sidebar";
import { ListIcon, SignOutIcon } from "@phosphor-icons/react";
import { errorMessage } from "@/features/shared/api";
import { panel } from "@/features/shared/rpc";

// The shell itself needs no request data, so the layout renders it
// synchronously; the identity and admin navigation slots stream in from
// Server Components once the session is known.
export function AppShell({
  identity,
  adminNavigation,
  children,
}: {
  identity: React.ReactNode;
  adminNavigation: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Sidebar.Provider
      defaultOpen
      collapsible="offcanvas"
      mobileBreakpoint={760}
      defaultWidth={224}
      className="flex-col"
    >
      <ShellContent identity={identity} adminNavigation={adminNavigation}>
        {children}
      </ShellContent>
    </Sidebar.Provider>
  );
}

export function NavLink({ href, label }: { href: string; label: string }) {
  const path = usePathname();
  const router = useRouter();
  const { setOpenMobile } = useSidebar();
  const active =
    path === href || (href !== "/admin" && path.startsWith(href + "/"));
  return (
    <Sidebar.MenuButton
      href={href}
      active={active}
      aria-current={active ? "page" : undefined}
      onClick={(event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        setOpenMobile(false);
        router.push(href);
      }}
    >
      {label}
    </Sidebar.MenuButton>
  );
}

export function AdminNavigation() {
  return (
    <Sidebar.Group>
      <Sidebar.GroupLabel>管理</Sidebar.GroupLabel>
      <Sidebar.Menu>
        <NavLink href="/admin" label="管理概览" />
        <NavLink href="/admin/machines" label="机器" />
        <NavLink href="/admin/users" label="用户" />
      </Sidebar.Menu>
    </Sidebar.Group>
  );
}

function ShellContent({
  identity,
  adminNavigation,
  children,
}: {
  identity: React.ReactNode;
  adminNavigation: React.ReactNode;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { openMobile, setOpenMobile } = useSidebar();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function logout() {
    setBusy(true);
    setError("");
    try {
      await panel.auth.logout({});
      router.replace("/login");
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <header className="shell-header">
        <div className="actions">
          <Button
            className="mobile-toggle"
            variant="ghost"
            shape="square"
            aria-label="打开导航"
            aria-expanded={openMobile}
            onClick={() => setOpenMobile(!openMobile)}
            icon={<ListIcon size={20} />}
          />
          <Link href="/" className="brand">
            bifurcation
          </Link>
        </div>
        <div className="actions">
          {identity}
          <Button
            variant="ghost"
            aria-label="退出登录"
            shape="square"
            icon={<SignOutIcon size={18} />}
            loading={busy}
            onClick={logout}
          />
        </div>
      </header>
      {error && (
        <Banner role="alert" variant="error">
          {error}
        </Banner>
      )}
      <div className="shell-body">
        <Sidebar aria-label="主导航">
          <Sidebar.Header className="mobile-toggle items-center justify-between">
            <span>主导航</span>
            <Sidebar.Close aria-label="关闭导航" />
          </Sidebar.Header>
          <Sidebar.Content>
            {adminNavigation}
            <Sidebar.Group>
              <Sidebar.GroupLabel>我的空间</Sidebar.GroupLabel>
              <Sidebar.Menu>
                <NavLink href="/overview" label="我的概览" />
                <NavLink href="/subscription" label="接入与订阅" />
                <NavLink href="/account" label="账号设置" />
              </Sidebar.Menu>
            </Sidebar.Group>
          </Sidebar.Content>
        </Sidebar>
        <main className="page-content" id="main-content">
          <div className="page-frame">{children}</div>
        </main>
      </div>
    </>
  );
}
