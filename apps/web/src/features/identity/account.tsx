"use client";

import {
  Banner,
  LayerCard,
  Table,
  Button,
  Input,
  Badge,
} from "@cloudflare/kumo";
import { ResourceState } from "@/components/resource-state";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import type { JsonObject } from "@bufbuild/protobuf";
import type { ApiKey, Passkey } from "@bifurcation/rpc/panel/types";
import { Modal, FormError } from "@/components/modal";
import { SecretResult } from "@/components/secret-result";
import { Reauthenticate } from "./reauth";
import { ApiError, date, errorMessage } from "@/features/shared/api";
import { useServerRefresh } from "@/features/shared/use-refresh";
import { panel } from "@/features/shared/rpc";
import { usePasskeySupport } from "./use-passkey-support";

type Action =
  | { kind: "passkey" | "password" | "key" }
  | { kind: "remove-passkey" | "revoke-key"; id: string; name: string };
// The page provides credentials; mutations re-render it.
export function Account({ apiKeys, passkeys }: { apiKeys: ApiKey[]; passkeys: Passkey[] }) {
  const router = useRouter();
  const passkeySupported = usePasskeySupport();
  const { refresh } = useServerRefresh();
  const [action, setAction] = useState<Action | null>(null);
  const [actionOpen, setActionOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reauth, setReauth] = useState(false);
  const [secret, setSecret] = useState("");
  const [notice, setNotice] = useState("");
  const open = (action: Action) => {
    setAction(action);
    setActionOpen(true);
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
            optionsJSON:
              flow.options as unknown as PublicKeyCredentialCreationOptionsJSON,
          });
          await panel.me.newPasskeyVerify({
            flowId: flow.flowId,
            response: response as unknown as JsonObject,
            name: String(values.get("name")),
          });
          refresh();
          setNotice("Passkey 已添加。");
          break;
        }
        case "password":
          await panel.me.changePassword({
            password: String(values.get("password")),
          });
          router.replace("/login");
          router.refresh();
          break;
        case "key": {
          const result = await panel.me.createApiKey({
            name: String(values.get("name")),
          });
          setSecret(result.token);
          refresh();
          break;
        }
        case "remove-passkey":
          await panel.me.deletePasskey({ id: action.id });
          refresh();
          setNotice("Passkey 已移除。");
          break;
        case "revoke-key":
          await panel.me.revokeApiKey({ id: action.id });
          refresh();
          setNotice("API Key 已撤销。");
          break;
      }
      setActionOpen(false);
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
    <div className="account-workspace">
      <div className="page-heading">
        <h1>账号设置</h1>
      </div>
      {notice && (
        <Banner role="status" variant="secondary" className="mb-6">
          {notice}
        </Banner>
      )}
      <section className="panel-section stack">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2>Passkey</h2>
          <Button
            variant="primary"
            disabled={!passkeySupported}
            onClick={() => open({ kind: "passkey" })}
          >
            添加 Passkey
          </Button>
        </div>
        <p>用设备解锁或安全密钥登录；后备密码也可独立登录。</p>
        {!passkeySupported && (
          <p className="subtle">
            当前浏览器不支持 Passkey，请使用后备密码登录。可换用支持的浏览器添加
            Passkey。
          </p>
        )}
        <LayerCard className="min-w-0 overflow-x-auto p-0">
          <Table className="w-full table-fixed tabular-nums">
            <Table.Header
              className={!passkeys.length ? "hidden" : undefined}
            >
              <Table.Row>
                <Table.Head className="w-2/3 sm:w-2/5">名称</Table.Head>
                <Table.Head className="hidden sm:table-cell">
                  创建时间
                </Table.Head>
                <Table.Head className="hidden sm:table-cell">备份</Table.Head>
                <Table.Head className="text-right">
                  <span className="sr-only">操作</span>
                </Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {passkeys.map((key) => (
                <Table.Row key={key.id}>
                  <Table.Cell className="break-words">
                    {key.name}
                    <div className="mt-1 space-y-1 text-kumo-subtle sm:hidden">
                      <p>创建于 {date(key.createdAt)}</p>
                      <p>{key.backedUp ? "已备份" : "本机"}</p>
                    </div>
                  </Table.Cell>
                  <Table.Cell className="hidden sm:table-cell">
                    {date(key.createdAt)}
                  </Table.Cell>
                  <Table.Cell className="hidden sm:table-cell">
                    {key.backedUp ? "已备份" : "本机"}
                  </Table.Cell>
                  <Table.Cell className="text-right">
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
                  </Table.Cell>
                </Table.Row>
              ))}
              {!passkeys.length && (
                <Table.Row>
                  <Table.Cell colSpan={4}>
                    <ResourceState
                      loading={false}
                      title="尚未添加 Passkey"
                      description="当前可使用后备密码登录。需要用设备解锁登录时，可添加 Passkey。"
                    />
                  </Table.Cell>
                </Table.Row>
              )}
            </Table.Body>
          </Table>
        </LayerCard>
      </section>
      <LayerCard render={<section />} className="panel stack">
        <h2>后备密码</h2>
        <p>无法使用 Passkey 时，使用后备密码登录。</p>
        <div>
          <Badge variant="secondary">已设置</Badge>
        </div>
        <div>
          <Button onClick={() => open({ kind: "password" })}>
            修改后备密码
          </Button>
        </div>
      </LayerCard>
      <section className="panel-section stack">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2>API Key</h2>
          <div className="actions">
            <span className="subtle">长期有效 · 可随时撤销</span>
            <Button onClick={() => open({ kind: "key" })}>创建 API Key</Button>
          </div>
        </div>
        <p>
          用于脚本和自动化，权限随当前账号变化。完整密钥仅创建时显示；撤销后调用立即失效。
        </p>
        <LayerCard className="min-w-0 overflow-x-auto p-0">
          <Table className="w-full table-fixed tabular-nums">
            <Table.Header
              className={!apiKeys.length ? "hidden" : undefined}
            >
              <Table.Row>
                <Table.Head className="w-2/3 sm:w-1/4">名称</Table.Head>
                <Table.Head className="hidden sm:table-cell">
                  密钥前缀
                </Table.Head>
                <Table.Head className="hidden sm:table-cell">
                  最近使用
                </Table.Head>
                <Table.Head className="hidden sm:table-cell">状态</Table.Head>
                <Table.Head className="text-right">
                  <span className="sr-only">操作</span>
                </Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {apiKeys.map((key) => (
                <Table.Row key={key.id}>
                  <Table.Cell className="break-words">
                    {key.name}
                    <div className="mt-1 space-y-1 text-kumo-subtle sm:hidden">
                      <p>
                        <code>{key.prefix}…</code>
                      </p>
                      <p>最近使用 {date(key.lastUsedAt)}</p>
                      <p>{key.revokedAt ? "已撤销" : "有效"}</p>
                    </div>
                  </Table.Cell>
                  <Table.Cell className="hidden break-all sm:table-cell">
                    <code>{key.prefix}…</code>
                  </Table.Cell>
                  <Table.Cell className="hidden sm:table-cell">
                    {date(key.lastUsedAt)}
                  </Table.Cell>
                  <Table.Cell className="hidden sm:table-cell">
                    {key.revokedAt ? "已撤销" : "有效"}
                  </Table.Cell>
                  <Table.Cell className="text-right">
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
                  </Table.Cell>
                </Table.Row>
              ))}
              {!apiKeys.length && (
                <Table.Row>
                  <Table.Cell colSpan={5}>
                    <ResourceState
                      loading={false}
                      title="尚未创建 API Key"
                      description="仅在需要脚本或自动化调用时创建；日常使用面板无需 API Key。"
                    />
                  </Table.Cell>
                </Table.Row>
              )}
            </Table.Body>
          </Table>
        </LayerCard>
      </section>
      {action && (
        <Modal
          title={titles[action.kind]}
          open={actionOpen}
          role={
            action.kind === "remove-passkey" || action.kind === "revoke-key"
              ? "alertdialog"
              : "dialog"
          }
          onClose={() => {
            if (!busy) setActionOpen(false);
          }}
        >
          <form
            key={`${action.kind}:${actionOpen}`}
            className="stack"
            onSubmit={submit}
          >
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
                <Banner variant="secondary">
                  修改后，所有设备的登录会话将失效，需要重新登录。
                </Banner>
                <Input
                  label="新后备密码"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  required
                />
                <Input
                  label="确认新密码"
                  name="confirm"
                  type="password"
                  autoComplete="new-password"
                  required
                />
              </>
            )}
            {action.kind === "remove-passkey" && (
              <p>
                移除“{action.name}”后，将无法再使用此 Passkey
                登录。你仍可使用其他已绑定的 Passkey
                或后备密码；此操作不会删除设备上的密钥副本。
              </p>
            )}
            {action.kind === "revoke-key" && (
              <p>
                撤销“{action.name}”后，使用此 Key
                的请求将立即失效。相关脚本需要改用新的密钥；当前登录和客户端订阅不受影响。
              </p>
            )}
            <FormError message={error} />
            <div className="mt-8 flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                disabled={busy}
                onClick={() => setActionOpen(false)}
              >
                取消
              </Button>
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
    </div>
  );
}
