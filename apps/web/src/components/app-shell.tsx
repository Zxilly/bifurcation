"use client";

import { Button, Banner, Sidebar } from "@cloudflare/kumo";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { useSidebar } from "@cloudflare/kumo/components/sidebar";
import { ListIcon, SignOutIcon } from "@phosphor-icons/react";
import { Role, type User } from "@bifurcation/rpc/panel/types";
import { errorMessage } from "@/features/shared/api";
import { panel } from "@/features/shared/rpc";
export function AppShell({
  user,
  children,
}: {
  user: Pick<User, "username" | "role">;
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
      <ShellContent user={user}>{children}</ShellContent>
    </Sidebar.Provider>
  );
}

function ShellContent({
  user,
  children,
}: {
  user: Pick<User, "username" | "role">;
  children: React.ReactNode;
}) {
  const path = usePathname();
  const router = useRouter();
  const { openMobile, setOpenMobile } = useSidebar();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const link = (href: string, label: string) => (
    <Sidebar.MenuButton
      href={href}
      active={
        path === href || (href !== "/admin" && path.startsWith(href + "/"))
      }
      aria-current={
        path === href || (href !== "/admin" && path.startsWith(href + "/"))
          ? "page"
          : undefined
      }
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
          <span
            className="max-w-32 truncate sm:max-w-none"
            title={user.username}
          >
            {user.username}
          </span>
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
            {user.role === Role.ADMIN && (
              <Sidebar.Group>
                <Sidebar.GroupLabel>管理</Sidebar.GroupLabel>
                <Sidebar.Menu>
                  {link("/admin", "管理概览")}
                  {link("/admin/machines", "机器")}
                  {link("/admin/users", "用户")}
                </Sidebar.Menu>
              </Sidebar.Group>
            )}
            <Sidebar.Group>
              <Sidebar.GroupLabel>我的空间</Sidebar.GroupLabel>
              <Sidebar.Menu>
                {link("/overview", "我的概览")}
                {link("/subscription", "接入与订阅")}
                {link("/account", "账号设置")}
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
