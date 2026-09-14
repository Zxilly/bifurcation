"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, LayerCard } from "@cloudflare/kumo";
import { FormError } from "@/components/modal";
import { errorMessage } from "@/features/shared/api";
import { panel } from "@/features/shared/rpc";

export function SetupForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const values = new FormData(event.currentTarget);
    if (values.get("password") !== values.get("confirm")) {
      setError("两次输入的密码不一致。");
      return;
    }
    setBusy(true);
    try {
      await panel.auth.setupAdministrator({
        username: String(values.get("username")),
        password: String(values.get("password")),
      });
      router.replace("/admin");
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <LayerCard render={<section />} className="auth-card">
        <div className="brand">bifurcation</div>
        <h1>创建管理员</h1>
        <p className="subtle">
          首次使用，请设置管理员账号。创建后即可管理用户和节点，之后可在账号设置中添加
          Passkey。
        </p>
        <form className="stack" onSubmit={submit}>
          <Input
            name="username"
            label="用户名"
            autoComplete="username"
            defaultValue="admin"
            minLength={3}
            maxLength={32}
            required
            description="3–32 位小写字母、数字、点、下划线或短横线。"
          />
          <Input
            name="password"
            label="后备密码"
            type="password"
            autoComplete="new-password"
            required
          />
          <Input
            name="confirm"
            label="确认后备密码"
            type="password"
            autoComplete="new-password"
            required
          />
          <FormError message={error} />
          <Button type="submit" variant="primary" loading={busy}>
            创建管理员并进入
          </Button>
        </form>
      </LayerCard>
    </div>
  );
}
