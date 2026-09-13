"use client";
import { useState } from "react";
import { Button, Input } from "@cloudflare/kumo";
import { startAuthentication } from "@simplewebauthn/browser";
import { Modal, FormError } from "@/components/modal";
import { api, errorMessage } from "@/features/shared/api";
export function Reauthenticate({
  onComplete,
  onClose,
}: {
  onComplete: () => void;
  onClose: () => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function passkey() {
    setBusy(true);
    setError("");
    try {
      const flow = await api<{
        flowId: string;
        options: Parameters<typeof startAuthentication>[0]["optionsJSON"];
      }>("/api/auth/passkey/options", {
        method: "POST",
        body: { purpose: "reauth" },
      });
      const response = await startAuthentication({ optionsJSON: flow.options });
      await api("/api/auth/passkey/verify", {
        method: "POST",
        body: { flowId: flow.flowId, response },
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
      await api("/api/auth/reauth/password", {
        method: "POST",
        body: { password: values.get("password") },
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
        <div>
          <Button onClick={passkey} loading={busy}>
            使用 Passkey 验证
          </Button>
        </div>
        <form className="stack" onSubmit={password}>
          <Input
            type="password"
            name="password"
            label="后备密码"
            autoComplete="current-password"
            required
          />
          <FormError message={error} />
          <div className="actions">
            <Button type="submit" variant="primary" loading={busy}>
              验证密码
            </Button>
            <Button type="button" onClick={onClose}>
              取消
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
