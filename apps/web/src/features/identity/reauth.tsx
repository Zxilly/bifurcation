"use client";
import { useState } from "react";
import { Button, Input } from "@cloudflare/kumo";
import { startAuthentication } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import type { JsonObject } from "@bufbuild/protobuf";
import { PasskeyPurpose } from "@bifurcation/rpc/panel/auth";
import { Modal, FormError } from "@/components/modal";
import { errorMessage } from "@/features/shared/api";
import { panel } from "@/features/shared/rpc";
import { usePasskeySupport } from "./use-passkey-support";
export function Reauthenticate({
  onComplete,
  onClose,
}: {
  onComplete: () => void;
  onClose: () => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const passkeySupported = usePasskeySupport();
  async function passkey() {
    setBusy(true);
    setError("");
    try {
      const flow = await panel.auth.passkeyOptions({
        purpose: PasskeyPurpose.REAUTH,
      });
      const response = await startAuthentication({
        optionsJSON:
          flow.options as unknown as PublicKeyCredentialRequestOptionsJSON,
      });
      await panel.auth.passkeyVerify({
        flowId: flow.flowId,
        response: response as unknown as JsonObject,
        name: "",
      });
      onComplete();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function password(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const values = new FormData(event.currentTarget);
    try {
      await panel.auth.reauthPassword({
        password: String(values.get("password")),
      });
      onComplete();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="验证身份" open onClose={onClose}>
      <div className="stack">
        <p className="subtle">继续此操作前，请重新验证身份。</p>
        {passkeySupported && (
          <div>
            <Button onClick={passkey} loading={busy}>
              使用 Passkey 验证
            </Button>
          </div>
        )}
        <form className="stack" onSubmit={password}>
          <Input
            type="password"
            name="password"
            label="后备密码"
            autoComplete="current-password"
            required
          />
          <FormError message={error} />
          <div className="mt-8 flex flex-wrap justify-end gap-2">
            <Button type="button" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" variant="primary" loading={busy}>
              验证密码
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
