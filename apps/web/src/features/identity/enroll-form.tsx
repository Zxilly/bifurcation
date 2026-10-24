"use client";

import { Banner, Button, Input } from "@cloudflare/kumo";
import { KeyIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import type { JsonObject } from "@bufbuild/protobuf";
import { FormError } from "@/components/modal";
import { errorMessage } from "@/features/shared/api";
import { panel } from "@/features/shared/rpc";
import { usePasskeySupport } from "./use-passkey-support";
import { AuthLayout } from "./auth-layout";

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
  const passkeySupported = usePasskeySupport();
  const [passwordOnly, setPasswordOnly] = useState(true);
  const usePasskey = passkeySupported && !passwordOnly;
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
      const response = usePasskey
        ? await startRegistration({
            optionsJSON:
              flow.options as unknown as PublicKeyCredentialCreationOptionsJSON,
          })
        : undefined;
      const completion = {
        token,
        flowId: flow.flowId,
        response: response as unknown as JsonObject | undefined,
        passwordOnly: !usePasskey,
        password: String(values.get("password")),
        name: usePasskey ? String(values.get("name")) : "",
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
    <AuthLayout
      title={recovery ? "恢复账号" : "激活账号"}
      notice={
        recovery && token && (
          <Banner variant="secondary">
            恢复后，旧 Passkey、密码和登录会话将失效；API Key 保留。
          </Banner>
        )
      }
      description={
        token
          ? usePasskey
            ? "创建 Passkey 并设置后备密码，两种方式均可独立登录。"
            : passkeySupported
              ? "仅设置后备密码即可登录。之后可在账号设置中添加 Passkey。"
              : "当前浏览器不支持 Passkey，可仅设置后备密码。之后可在支持的浏览器中添加 Passkey。"
          : undefined
      }
      secondaryAction={
        token && passkeySupported && (
          <Button
            type="button"
            icon={KeyIcon}
            disabled={busy}
            onClick={() => {
              setPasswordOnly(!passwordOnly);
              setError("");
            }}
          >
            {passwordOnly ? "添加 Passkey（可选）" : "仅设置后备密码"}
          </Button>
        )
      }
    >
      {!token ? (
        <Banner variant="error" role="alert">
          链接缺少凭据，请向管理员获取新的链接。
        </Banner>
      ) : (
        <form className="stack auth-form" onSubmit={submit}>
          {usePasskey && (
            <Input
              name="name"
              label="Passkey 名称"
              placeholder="例如：Windows Hello"
              required
              maxLength={64}
            />
          )}
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
          <div className="actions auth-submit">
            <Button variant="primary" type="submit" loading={busy}>
              {usePasskey
                ? recovery
                  ? "创建 Passkey 并恢复"
                  : "创建 Passkey 并激活"
                : recovery
                  ? "设置密码并恢复"
                  : "设置密码并激活"}
            </Button>
          </div>
        </form>
      )}
    </AuthLayout>
  );
}
