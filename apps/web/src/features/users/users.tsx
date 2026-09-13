"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Badge } from "@cloudflare/kumo";
import type { UserDto } from "@/contracts/identity";
import { Modal, FormError } from "@/components/modal";
import { SecretResult } from "@/components/secret-result";
import { Reauthenticate } from "@/features/identity/reauth";
import { api, ApiError, errorMessage } from "@/features/shared/api";
import { useResource } from "@/features/shared/use-resource";
import { UserNodeUsage } from "@/features/usage/overview";

const status = { pending: "待激活", active: "正常", disabled: "已禁用" };
type Action =
  | { kind: "create" }
  | {
      kind: "edit" | "disable" | "enable" | "recover" | "activate";
      user: UserDto;
    };
export function Users() {
  const router = useRouter();
  const resource = useResource<{ users: UserDto[] }>("/api/v1/admin/users");
  const [action, setAction] = useState<Action | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reauth, setReauth] = useState(false);
  const [result, setResult] = useState<{ title: string; url: string } | null>(
    null,
  );
  function open(value: Action) {
    setError("");
    setAction(value);
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
        const body = {
          role: values.get("role"),
          monthlyLimitBytes:
            amount === null ? null : String(Math.round(amount * 1073741824)),
        };
        if (action.kind === "create") {
          const created = await api<{ user: UserDto; activationUrl: string }>(
            "/api/v1/admin/users",
            {
              method: "POST",
              body: { ...body, username: values.get("username") },
            },
          );
          setResult({ title: "用户已创建", url: created.activationUrl });
        } else
          await api(`/api/v1/admin/users/${action.user.id}`, {
            method: "PATCH",
            body: { ...body, expectedVersion: action.user.version },
          });
      } else if (action.kind === "activate" || action.kind === "recover") {
        const created = await api<{ url: string; expiresAt: number }>(
          `/api/v1/admin/users/${action.user.id}/${action.kind === "activate" ? "activation" : "recovery"}`,
          { method: "POST", body: {} },
        );
        setResult({
          title: action.kind === "activate" ? "激活链接" : "恢复链接",
          url: created.url,
        });
      } else
        await api(`/api/v1/admin/users/${action.user.id}`, {
          method: "PATCH",
          body: {
            expectedVersion: action.user.version,
            status: action.kind === "disable" ? "disabled" : "active",
          },
        });
      setAction(null);
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
        enable: "恢复使用",
        recover: "恢复账号",
        activate: "重新生成激活链接",
      }[action.kind]
    : "";
  const editUser = action && action.kind !== "create" ? action.user : null;
  return (
    <>
      <div className="page-heading">
        <h1>用户</h1>
        <Button variant="primary" onClick={() => open({ kind: "create" })}>
          创建用户
        </Button>
      </div>
      <section className="panel">
        <FormError message={resource.error} />
        {resource.error && <Button onClick={resource.refresh}>重新加载</Button>}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>用户名</th>
                <th>角色</th>
                <th>每月额度</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {resource.data?.users.map((user) => (
                <tr key={user.id}>
                  <td>{user.username}</td>
                  <td>{user.role === "admin" ? "管理员" : "用户"}</td>
                  <td>
                    {user.monthlyLimitBytes === null
                      ? "不限量"
                      : `${(Number(user.monthlyLimitBytes) / 1073741824).toLocaleString("zh-CN")} GiB`}
                  </td>
                  <td>
                    <Badge
                      variant={
                        user.status === "disabled" ? "destructive" : "secondary"
                      }
                    >
                      {status[user.status]}
                    </Badge>
                  </td>
                  <td>
                    <div className="actions">
                      <Button
                        variant="ghost"
                        onClick={() => open({ kind: "edit", user })}
                      >
                        编辑
                      </Button>
                      {user.status === "pending" ? (
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
                            onClick={() =>
                              open({
                                kind:
                                  user.status === "disabled"
                                    ? "enable"
                                    : "disable",
                                user,
                              })
                            }
                          >
                            {user.status === "disabled" ? "恢复使用" : "禁用"}
                          </Button>
                          <Button
                            variant="ghost"
                            disabled={user.status === "disabled"}
                            title={
                              user.status === "disabled"
                                ? "请先恢复使用，再恢复登录凭据"
                                : undefined
                            }
                            onClick={() => open({ kind: "recover", user })}
                          >
                            恢复账号
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!resource.data?.users.length && (
            <p className="empty-state">
              {resource.loading
                ? "正在加载…"
                : resource.error
                  ? "未能加载用户"
                  : "暂无用户"}
            </p>
          )}
        </div>
      </section>
      <UserNodeUsage />
      {action && (
        <Modal
          title={title}
          open
          onClose={() => {
            if (!busy) setAction(null);
          }}
        >
          <form className="stack" onSubmit={submit}>
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
                <label className="stack gap-2">
                  角色
                  <select
                    className="field-select"
                    name="role"
                    defaultValue={editUser?.role ?? "user"}
                  >
                    <option value="user">用户</option>
                    <option value="admin">管理员</option>
                  </select>
                </label>
                <Input
                  label="每月额度（GiB）"
                  name="quota"
                  type="number"
                  min="0"
                  step="any"
                  defaultValue={
                    editUser?.monthlyLimitBytes
                      ? Number(editUser.monthlyLimitBytes) / 1073741824
                      : editUser?.monthlyLimitBytes === "0"
                        ? 0
                        : ""
                  }
                  description="留空为不限量；0 表示不允许使用流量。"
                />
              </>
            ) : (
              <p>
                {action.kind === "disable"
                  ? `禁用“${editUser?.username}”后，将无法登录和使用代理。`
                  : action.kind === "recover"
                    ? `生成“${editUser?.username}”的恢复链接。完成恢复后，旧 Passkey、密码和登录会话将失效。`
                    : action.kind === "activate"
                      ? `旧激活链接将失效，请将新链接交给“${editUser?.username}”。`
                      : `允许“${editUser?.username}”重新使用账号。`}
              </p>
            )}
            <FormError message={error} />
            <div className="actions">
              <Button
                type="submit"
                variant={action.kind === "disable" ? "destructive" : "primary"}
                loading={busy}
              >
                {title}
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
      {result && (
        <SecretResult
          title={result.title}
          value={result.url}
          onClose={() => setResult(null)}
        />
      )}
    </>
  );
}
