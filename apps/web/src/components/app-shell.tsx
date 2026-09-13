"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@cloudflare/kumo";
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
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const link = (href: string, label: string) => (
    <Link
      className="nav-link"
      href={href}
      aria-current={
        path === href || (href !== "/admin" && path.startsWith(href + "/"))
          ? "page"
          : undefined
      }
      onClick={() => setOpen(false)}
    >
      {label}
    </Link>
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
            aria-expanded={open}
            onClick={() => setOpen(!open)}
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
        <p role="alert" className="form-error p-3">
          {error}
        </p>
      )}
      <div className="shell-body">
        <nav className="sidebar" data-open={open} aria-label="主导航">
          {user.role === Role.ADMIN && (
            <div className="nav-group">
              <p className="nav-label">管理</p>
              {link("/admin", "管理概览")}
              {link("/admin/machines", "机器")}
              {link("/admin/users", "用户")}
            </div>
          )}
          <div className="nav-group">
            <p className="nav-label">我的空间</p>
            {link("/overview", "我的概览")}
            {link("/subscription", "接入与订阅")}
            {link("/account", "账号设置")}
          </div>
        </nav>
        <main className="page-content" id="main-content">
          {children}
        </main>
      </div>
    </>
  );
}
