"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Badge } from "@cloudflare/kumo";
import { startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import type { JsonObject } from "@bufbuild/protobuf";
import { Modal, FormError } from "@/components/modal";
import { SecretResult } from "@/components/secret-result";
import { Reauthenticate } from "./reauth";
import { ApiError, date, errorMessage } from "@/features/shared/api";
import { useResource } from "@/features/shared/use-resource";
import { panel } from "@/features/shared/rpc";

type Action =
  | { kind: "passkey" | "password" | "key" }
  | { kind: "remove-passkey" | "revoke-key"; id: string; name: string };
export function Account() {
  const router = useRouter();
  const keys = useResource("me:api-keys", () => panel.me.listApiKeys({}));
  const passkeys = useResource("me:passkeys", () => panel.me.listPasskeys({}));
  const [action, setAction] = useState<Action | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reauth, setReauth] = useState(false);
  const [secret, setSecret] = useState("");
  const [notice, setNotice] = useState("");
  const open = (action: Action) => {
    setAction(action);
    setError("");
    setNotice("");
  };
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!action) return;
    const values = new FormData(event.currentTarget);
    setError("");
    if (
      action.kind === "password" &&
      values.get("password") !== values.get("confirm")
    ) {
      setError("两次输入的密码不一致。");
      return;
    }
    setBusy(true);
    try {
      switch (action.kind) {
        case "passkey": {
          const flow = await panel.me.newPasskeyOptions({});
          const response = await startRegistration({
            optionsJSON: flow.options as unknown as PublicKeyCredentialCreationOptionsJSON,
          });
          await panel.me.newPasskeyVerify({
            flowId: flow.flowId,
            response: response as unknown as JsonObject,
            name: String(values.get("name")),
          });
          await passkeys.refresh();
          setNotice("Passkey 已添加。");
          break;
        }
        case "password":
          await panel.me.changePassword({ password: String(values.get("password")) });
          router.replace("/login");
          router.refresh();
          break;
        case "key": {
          const result = await panel.me.createApiKey({ name: String(values.get("name")) });
          setSecret(result.token);
          await keys.refresh();
          break;
        }
        case "remove-passkey":
          await panel.me.deletePasskey({ id: action.id });
          await passkeys.refresh();
          setNotice("Passkey 已移除。");
          break;
        case "revoke-key":
          await panel.me.revokeApiKey({ id: action.id });
          await keys.refresh();
          setNotice("API Key 已撤销。");
          break;
      }
      setAction(null);
    } catch (e) {
      if (e instanceof ApiError && e.code === "REAUTH_REQUIRED")
        setReauth(true);
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const titles = {
    passkey: "添加 Passkey",
    password: "修改后备密码",
    key: "创建 API Key",
    "remove-passkey": "移除 Passkey",
    "revoke-key": "撤销 API Key",
  };
  return (
    <>
      <div className="page-heading">
        <h1>账号设置</h1>
      </div>
      {notice && (
        <p role="status" className="notice mb-6">
          {notice}
        </p>
      )}
      <section className="panel">
        <h2>Passkey</h2>
        <FormError message={passkeys.error} />
        {passkeys.error && <Button onClick={passkeys.refresh}>重新加载</Button>}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>创建时间</th>
                <th>备份</th>
                <th>
                  <span className="sr-only">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {passkeys.data?.passkeys.map((key) => (
                <tr key={key.id}>
                  <td>{key.name}</td>
                  <td>{date(key.createdAt)}</td>
                  <td>{key.backedUp ? "已备份" : "本机"}</td>
                  <td>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        open({
                          kind: "remove-passkey",
                          id: key.id,
                          name: key.name,
                        })
                      }
                    >
                      移除
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!passkeys.data?.passkeys.length && (
            <p className="empty-state">
              {passkeys.loading
                ? "正在加载…"
                : passkeys.error
                  ? "未能加载 Passkey"
                  : "尚未添加 Passkey"}
            </p>
          )}
        </div>
        <Button variant="primary" onClick={() => open({ kind: "passkey" })}>
          添加 Passkey
        </Button>
      </section>
      <section className="panel stack">
        <h2>后备密码</h2>
        <div>
          <Badge variant="secondary">已设置</Badge>
        </div>
        <div>
          <Button onClick={() => open({ kind: "password" })}>
            修改后备密码
          </Button>
        </div>
      </section>
      <section className="panel">
        <div className="panel-header">
          <h2>API Key</h2>
          <span className="subtle text-xs">长期有效</span>
        </div>
        <FormError message={keys.error} />
        {keys.error && <Button onClick={keys.refresh}>重新加载</Button>}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>密钥前缀</th>
                <th>最近使用</th>
                <th>状态</th>
                <th>
                  <span className="sr-only">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {keys.data?.apiKeys.map((key) => (
                <tr key={key.id}>
                  <td>{key.name}</td>
                  <td>
                    <code>{key.prefix}…</code>
                  </td>
                  <td>{date(key.lastUsedAt)}</td>
                  <td>{key.revokedAt ? "已撤销" : "有效"}</td>
                  <td>
                    {!key.revokedAt && (
                      <Button
                        variant="ghost"
                        onClick={() =>
                          open({
                            kind: "revoke-key",
                            id: key.id,
                            name: key.name,
                          })
                        }
                      >
                        撤销
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!keys.data?.apiKeys.length && (
            <p className="empty-state">
              {keys.loading
                ? "正在加载…"
                : keys.error
                  ? "未能加载 API Key"
                  : "尚未创建 API Key"}
            </p>
          )}
        </div>
        <Button onClick={() => open({ kind: "key" })}>创建 API Key</Button>
      </section>
      {action && (
        <Modal
          title={titles[action.kind]}
          open
          onClose={() => {
            if (!busy) setAction(null);
          }}
        >
          <form className="stack" onSubmit={submit}>
            {(action.kind === "passkey" || action.kind === "key") && (
              <Input
                label="名称"
                name="name"
                maxLength={64}
                required
                placeholder={
                  action.kind === "passkey"
                    ? "例如：Windows Hello"
                    : "例如：自动更新配置"
                }
              />
            )}
            {action.kind === "password" && (
              <>
                <p className="notice">
                  修改后，所有设备的登录会话将失效，需要重新登录。
                </p>
                <Input
                  label="新后备密码"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  description="至少 12 个字符。"
                />
                <Input
                  label="确认新密码"
                  name="confirm"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                />
              </>
            )}
            {action.kind === "remove-passkey" && (
              <p>移除“{action.name}”后，将无法再使用此 Passkey 登录。</p>
            )}
            {action.kind === "revoke-key" && (
              <p>撤销“{action.name}”后，使用此 Key 的请求将立即失效。</p>
            )}
            <FormError message={error} />
            <div className="actions">
              <Button
                type="submit"
                variant={
                  action.kind.startsWith("remove") ||
                  action.kind.startsWith("revoke")
                    ? "destructive"
                    : "primary"
                }
                loading={busy}
              >
                {titles[action.kind]}
              </Button>
              <Button
                type="button"
                disabled={busy}
                onClick={() => setAction(null)}
              >
                取消
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {reauth && (
        <Reauthenticate
          onClose={() => setReauth(false)}
          onComplete={() => {
            setReauth(false);
            setError("身份已验证，请再次提交。");
          }}
        />
      )}
      {secret && (
        <SecretResult
          title="API Key 已创建"
          value={secret}
          onClose={() => setSecret("")}
        />
      )}
    </>
  );
}
