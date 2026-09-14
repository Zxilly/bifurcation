"use client";

import {
  LayerCard,
  Table,
  Button,
  Input,
  Badge,
  Select,
} from "@cloudflare/kumo";
import { ResourceState } from "@/components/resource-state";
import { ResourceFeedback } from "@/components/resource-feedback";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Role, UserStatus, type User } from "@bifurcation/rpc/panel/types";
import { FlowPurpose } from "@bifurcation/rpc/panel/users";
import { Modal, FormError } from "@/components/modal";
import { SecretResult } from "@/components/secret-result";
import { Reauthenticate } from "@/features/identity/reauth";
import { ApiError, errorMessage } from "@/features/shared/api";
import { panel } from "@/features/shared/rpc";
import { useResource } from "@/features/shared/use-resource";
import { UserNodeUsage } from "@/features/usage/overview";

const status: Record<number, string> = {
  [UserStatus.PENDING]: "待激活",
  [UserStatus.ACTIVE]: "正常",
  [UserStatus.DISABLED]: "已禁用",
};
type Action =
  | { kind: "create" }
  | {
      kind: "edit" | "disable" | "enable" | "recover" | "activate";
      user: User;
    };

function monthlyQuota(user: User) {
  return user.monthlyLimitBytes === undefined
    ? "不限量"
    : `${(Number(user.monthlyLimitBytes) / 1073741824).toLocaleString("zh-CN")} GiB`;
}

export function Users() {
  const router = useRouter();
  const resource = useResource("admin-users", () => panel.users.listUsers({}));
  const [action, setAction] = useState<Action | null>(null);
  const [actionOpen, setActionOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reauth, setReauth] = useState(false);
  const [result, setResult] = useState<{ title: string; url: string } | null>(
    null,
  );
  function open(value: Action) {
    setError("");
    setAction(value);
    setActionOpen(true);
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!action) return;
    setError("");
    setBusy(true);
    const values = new FormData(event.currentTarget);
    try {
      if (action.kind === "create" || action.kind === "edit") {
        const quota = String(values.get("quota") ?? "").trim();
        const amount = quota === "" ? null : Number(quota);
        if (
          amount !== null &&
          (!Number.isFinite(amount) ||
            amount < 0 ||
            !Number.isSafeInteger(Math.round(amount * 1073741824)))
        )
          throw new Error("请输入有效的每月额度。");
        const role = values.get("role") === "admin" ? Role.ADMIN : Role.USER;
        if (action.kind === "create") {
          const created = await panel.users.createUser({
            username: String(values.get("username")),
            role,
            monthlyLimitBytes:
              amount === null
                ? undefined
                : String(Math.round(amount * 1073741824)),
          });
          setResult({ title: "用户已创建", url: created.activationUrl });
        } else
          await panel.users.updateUser({
            id: action.user.id,
            expectedVersion: action.user.version,
            role,
            monthlyLimitBytes:
              amount === null
                ? undefined
                : String(Math.round(amount * 1073741824)),
            clearMonthlyLimit: amount === null,
          });
      } else if (action.kind === "activate" || action.kind === "recover") {
        const created = await panel.users.createUserFlow({
          id: action.user.id,
          purpose:
            action.kind === "activate"
              ? FlowPurpose.ACTIVATION
              : FlowPurpose.RECOVERY,
        });
        setResult({
          title: action.kind === "activate" ? "激活链接" : "恢复链接",
          url: created.url,
        });
      } else
        await panel.users.updateUser({
          id: action.user.id,
          expectedVersion: action.user.version,
          status:
            action.kind === "disable" ? UserStatus.DISABLED : UserStatus.ACTIVE,
        });
      setActionOpen(false);
      await resource.refresh();
      router.refresh();
    } catch (e) {
      if (e instanceof ApiError && e.code === "REAUTH_REQUIRED")
        setReauth(true);
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const title = action
    ? {
        create: "创建用户",
        edit: "编辑用户",
        disable: "禁用用户",
        enable: "启用账号",
        recover: "恢复登录凭据",
        activate: "重新生成激活链接",
      }[action.kind]
    : "";
  const editUser = action && action.kind !== "create" ? action.user : null;
  const activeAdmins =
    resource.data?.users.filter(
      (user) => user.role === Role.ADMIN && user.status === UserStatus.ACTIVE,
    ) ?? [];
  const lastAdminId = activeAdmins.length === 1 ? activeAdmins[0].id : null;
  return (
    <div className="users-workspace">
      <div className="page-heading">
        <h1>用户</h1>
        <Button variant="primary" onClick={() => open({ kind: "create" })}>
          创建用户
        </Button>
      </div>
      <section className="panel-section stack">
        <p className="subtle">
          {resource.data ? `${resource.data.users.length} 位用户 · ` : ""}
          通过一次性激活链接加入
        </p>
        <ResourceFeedback {...resource} onRetry={resource.refresh} />
        <LayerCard className="min-w-0 overflow-x-auto p-0">
          <Table className="w-full table-fixed tabular-nums">
            <Table.Header>
              <Table.Row>
                <Table.Head className="w-1/2 md:w-1/5">用户名</Table.Head>
                <Table.Head className="hidden md:table-cell">角色</Table.Head>
                <Table.Head className="hidden text-right whitespace-nowrap md:table-cell">
                  每月额度
                </Table.Head>
                <Table.Head className="hidden md:table-cell">状态</Table.Head>
                <Table.Head className="md:w-1/3">操作</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {resource.data?.users.map((user) => (
                <Table.Row key={user.id}>
                  <Table.Cell className="break-words">
                    {user.username}
                    <div className="mt-1 space-y-1 md:hidden">
                      <p>
                        {user.role === Role.ADMIN ? "管理员" : "用户"} ·{" "}
                        {status[user.status]}
                      </p>
                      <p>每月额度：{monthlyQuota(user)}</p>
                    </div>
                    {user.id === lastAdminId && (
                      <p className="mt-1 text-kumo-subtle">
                        最后一个启用管理员，不能禁用或降级。
                      </p>
                    )}
                  </Table.Cell>
                  <Table.Cell className="hidden md:table-cell">
                    {user.role === Role.ADMIN ? "管理员" : "用户"}
                  </Table.Cell>
                  <Table.Cell className="hidden text-right whitespace-nowrap md:table-cell">
                    {monthlyQuota(user)}
                  </Table.Cell>
                  <Table.Cell className="hidden md:table-cell">
                    <Badge
                      variant={
                        user.status === UserStatus.DISABLED
                          ? "destructive"
                          : "secondary"
                      }
                    >
                      {status[user.status]}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell>
                    <div className="actions">
                      <Button
                        variant="ghost"
                        onClick={() => open({ kind: "edit", user })}
                      >
                        编辑
                      </Button>
                      {user.status === UserStatus.PENDING ? (
                        <Button
                          variant="ghost"
                          onClick={() => open({ kind: "activate", user })}
                        >
                          激活链接
                        </Button>
                      ) : (
                        <>
                          <Button
                            variant="ghost"
                            disabled={user.id === lastAdminId}
                            onClick={() =>
                              open({
                                kind:
                                  user.status === UserStatus.DISABLED
                                    ? "enable"
                                    : "disable",
                                user,
                              })
                            }
                          >
                            {user.status === UserStatus.DISABLED
                              ? "启用账号"
                              : "禁用"}
                          </Button>
                          <Button
                            variant="ghost"
                            disabled={user.status === UserStatus.DISABLED}
                            title={
                              user.status === UserStatus.DISABLED
                                ? "请先启用账号，再恢复登录凭据"
                                : undefined
                            }
                            onClick={() => open({ kind: "recover", user })}
                          >
                            恢复登录凭据
                          </Button>
                        </>
                      )}
                    </div>
                  </Table.Cell>
                </Table.Row>
              ))}
              {!resource.data?.users.length && (
                <Table.Row>
                  <Table.Cell colSpan={5}>
                    <ResourceState
                      loading={resource.loading}
                      title={
                        resource.loading
                          ? "正在加载…"
                          : resource.error
                            ? "未能加载用户"
                            : "暂无用户"
                      }
                    />
                  </Table.Cell>
                </Table.Row>
              )}
            </Table.Body>
          </Table>
        </LayerCard>
      </section>
      <UserNodeUsage />
      {action && (
        <Modal
          title={title}
          open={actionOpen}
          role={action.kind === "disable" ? "alertdialog" : "dialog"}
          onClose={() => {
            if (!busy) setActionOpen(false);
          }}
        >
          <form
            key={`${action.kind}:${editUser?.id ?? ""}:${actionOpen}`}
            className="stack"
            onSubmit={submit}
          >
            {action.kind === "create" || action.kind === "edit" ? (
              <>
                {action.kind === "create" ? (
                  <Input
                    label="用户名"
                    name="username"
                    autoComplete="off"
                    minLength={3}
                    maxLength={32}
                    description="3–32 位字母、数字、点、下划线或短横线。"
                    required
                  />
                ) : (
                  <p>{editUser?.username}</p>
                )}
                <Select
                  label="角色"
                  items={{ user: "用户", admin: "管理员" }}
                  name="role"
                  defaultValue={
                    editUser?.role === Role.ADMIN ? "admin" : "user"
                  }
                  disabled={!!editUser && editUser.id === lastAdminId}
                />
                {editUser?.id === lastAdminId && (
                  <>
                    <input type="hidden" name="role" value="admin" />
                    <p className="subtle">
                      这是最后一个启用的管理员，不能降级；可调整每月额度。
                    </p>
                  </>
                )}
                <Input
                  label="每月额度（GiB）"
                  name="quota"
                  type="number"
                  min="0"
                  step="any"
                  defaultValue={
                    editUser?.monthlyLimitBytes !== undefined
                      ? Number(editUser.monthlyLimitBytes) / 1073741824
                      : ""
                  }
                  description="留空为不限量；0 表示不允许使用流量。"
                />
              </>
            ) : (
              <p>
                {action.kind === "disable"
                  ? `禁用“${editUser?.username}”后，将无法登录或使用 API Key。代理访问撤销需等待节点确认，离线节点不能视为已完成。历史用量保留。`
                  : action.kind === "recover"
                    ? `生成“${editUser?.username}”的恢复链接。完成恢复后，旧 Passkey、密码和登录会话将失效，API Key 保留。用户可仅设置密码，也可添加新的 Passkey。`
                    : action.kind === "activate"
                      ? `旧激活链接将失效，请将新链接交给“${editUser?.username}”。`
                      : `允许“${editUser?.username}”重新登录和使用 API Key。代理接入仍受额度限制，以节点确认结果为准。`}
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
                variant={action.kind === "disable" ? "destructive" : "primary"}
                loading={busy}
              >
                {title}
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
      {result && (
        <SecretResult
          title={result.title}
          value={result.url}
          onClose={() => setResult(null)}
        />
      )}
    </div>
  );
}
