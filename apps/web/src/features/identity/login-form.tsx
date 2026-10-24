"use client";

import { Button, Input } from "@cloudflare/kumo";
import { KeyIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { startAuthentication } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import type { JsonObject } from "@bufbuild/protobuf";
import { PasskeyPurpose } from "@bifurcation/rpc/panel/auth";
import { Role, type User } from "@bifurcation/rpc/panel/types";
import { errorMessage } from "@/features/shared/api";
import { panel } from "@/features/shared/rpc";
import { FormError } from "@/components/modal";
import { usePasskeySupport } from "./use-passkey-support";
import { AuthLayout } from "./auth-layout";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"passkey" | "password" | null>(null);
  const passkeySupported = usePasskeySupport();
  function complete(user: User) {
    router.replace(user.role === Role.ADMIN ? "/admin" : "/overview");
    router.refresh();
  }
  async function passkey() {
    setError("");
    setBusy("passkey");
    try {
      const flow = await panel.auth.passkeyOptions({
        purpose: PasskeyPurpose.LOGIN,
      });
      const response = await startAuthentication({
        optionsJSON:
          flow.options as unknown as PublicKeyCredentialRequestOptionsJSON,
      });
      const result = await panel.auth.passkeyVerify({
        flowId: flow.flowId,
        response: response as unknown as JsonObject,
        name: "",
      });
      complete(result.user!);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  async function password(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy("password");
    const data = new FormData(event.currentTarget);
    try {
      const result = await panel.auth.passwordLogin({
        username: String(data.get("username")),
        password: String(data.get("password")),
      });
      complete(result.user!);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <AuthLayout
      title="欢迎回来"
      description={
        passkeySupported
          ? "使用后备密码或 Passkey 登录你的账号。"
          : "当前环境无法使用 Passkey，请使用后备密码登录。"
      }
      secondaryAction={
        passkeySupported && (
          <Button
            icon={KeyIcon}
            loading={busy === "passkey"}
            disabled={busy !== null}
            onClick={passkey}
          >
            使用 Passkey 登录
          </Button>
        )
      }
      footer="无法登录？联系管理员恢复账号。"
    >
      <form onSubmit={password} className="stack auth-form">
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
        <div className="actions auth-submit">
          <Button
            type="submit"
            variant="primary"
            loading={busy === "password"}
            disabled={busy !== null}
          >
            登录
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}
