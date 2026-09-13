"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input } from "@cloudflare/kumo";
import { startAuthentication } from "@simplewebauthn/browser";
import type { UserDto } from "@/contracts/identity";
import { api, errorMessage } from "@/features/shared/api";
import { FormError } from "@/components/modal";

export function LoginForm() {
  const router = useRouter();
  const [passwordMode, setPasswordMode] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  function complete(user: UserDto) {
    router.replace(user.role === "admin" ? "/admin" : "/overview");
    router.refresh();
  }
  async function passkey() {
    setError("");
    setBusy(true);
    try {
      const flow = await api<{
        flowId: string;
        options: Parameters<typeof startAuthentication>[0]["optionsJSON"];
      }>("/api/auth/passkey/options", {
        method: "POST",
        body: { purpose: "login" },
      });
      const response = await startAuthentication({ optionsJSON: flow.options });
      const result = await api<{ user: UserDto }>("/api/auth/passkey/verify", {
        method: "POST",
        body: { flowId: flow.flowId, response },
      });
      complete(result.user);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function password(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const data = new FormData(event.currentTarget);
    try {
      const result = await api<{ user: UserDto }>("/api/auth/password", {
        method: "POST",
        body: {
          username: data.get("username"),
          password: data.get("password"),
        },
      });
      complete(result.user);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-page">
      <section className="auth-card">
        <div className="brand">bifurcation</div>
        <h1>欢迎回来</h1>
        {passwordMode ? (
          <form onSubmit={password} className="stack">
            <Input
              label="用户名"
              name="username"
              autoComplete="username"
              required
              maxLength={64}
            />
            <Input
              label="后备密码"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
            <FormError message={error} />
            <div className="actions">
              <Button type="submit" variant="primary" loading={busy}>
                登录
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setPasswordMode(false);
                  setError("");
                }}
              >
                使用 Passkey
              </Button>
            </div>
          </form>
        ) : (
          <div className="stack">
            <div>
              <Button variant="primary" loading={busy} onClick={passkey}>
                使用 Passkey 登录
              </Button>
            </div>
            <FormError message={error} />
            <div>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setPasswordMode(true);
                  setError("");
                }}
              >
                使用后备密码
              </Button>
            </div>
          </div>
        )}
        <footer>无法登录？联系管理员恢复账号。</footer>
      </section>
    </div>
  );
}
