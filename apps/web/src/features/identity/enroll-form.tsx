"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input } from "@cloudflare/kumo";
import { startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import type { JsonObject } from "@bufbuild/protobuf";
import { FormError } from "@/components/modal";
import { errorMessage } from "@/features/shared/api";
import { panel } from "@/features/shared/rpc";

export function EnrollForm({
  token,
  recovery,
}: {
  token: string;
  recovery: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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
      const flow = recovery
        ? await panel.auth.recoveryOptions({ token })
        : await panel.auth.activationOptions({ token });
      const response = await startRegistration({
        optionsJSON: flow.options as unknown as PublicKeyCredentialCreationOptionsJSON,
      });
      const completion = {
        token,
        flowId: flow.flowId,
        response: response as unknown as JsonObject,
        password: String(values.get("password")),
        name: String(values.get("name")),
      };
      if (recovery) await panel.auth.recoveryComplete(completion);
      else await panel.auth.activationComplete(completion);
      router.replace("/account");
      router.refresh();
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
        <h1>{recovery ? "恢复账号" : "激活账号"}</h1>
        {!token ? (
          <p role="alert">链接缺少凭据，请向管理员获取新的链接。</p>
        ) : (
          <form className="stack" onSubmit={submit}>
            {recovery && (
              <p className="notice">
                恢复后，旧 Passkey、密码和登录会话将失效。
              </p>
            )}
            <Input
              name="name"
              label="Passkey 名称"
              placeholder="例如：Windows Hello"
              required
              maxLength={64}
            />
            <Input
              name="password"
              label="后备密码"
              type="password"
              autoComplete="new-password"
              minLength={12}
              required
              description="至少 12 个字符。"
            />
            <Input
              name="confirm"
              label="确认后备密码"
              type="password"
              autoComplete="new-password"
              minLength={12}
              required
            />
            <FormError message={error} />
            <Button variant="primary" type="submit" loading={busy}>
              {recovery ? "创建 Passkey 并恢复" : "创建 Passkey 并激活"}
            </Button>
          </form>
        )}
      </section>
    </div>
  );
}
