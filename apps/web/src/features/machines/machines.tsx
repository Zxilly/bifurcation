"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Input, Badge } from "@cloudflare/kumo";
import type { MachineDto, MachineDetailDto } from "@/contracts/machines";
import { Modal, FormError } from "@/components/modal";
import { CopyValue } from "@/components/secret-result";
import { Reauthenticate } from "@/features/identity/reauth";
import { api, ApiError, date, errorMessage } from "@/features/shared/api";
import { useResource } from "@/features/shared/use-resource";
import { MachineConfiguration } from "@/features/configuration/machine-configuration";
import { MachineResources } from "./resources";
import { MachineUsage } from "@/features/usage/overview";
import { MachineUpgrades } from "./upgrades";
import { ActiveTasks, TaskHistory } from "./tasks";
import { MachineInformationAction } from "./information";

const connection = { waiting: "待接入", online: "在线", offline: "失联" };
export function Machines() {
  const router = useRouter();
  const resource = useResource<{ machines: MachineDto[] }>(
    "/api/v1/admin/machines",
  );
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reauth, setReauth] = useState(false);
  useEffect(() => {
    const interval = setInterval(resource.refresh, 10000);
    return () => clearInterval(interval);
  }, [resource.refresh]);
  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const { machine } = await api<{ machine: MachineDetailDto }>(
        "/api/v1/admin/machines",
        {
          method: "POST",
          body: {
            name: values.get("name"),
            address: values.get("address"),
            region: values.get("region"),
          },
        },
      );
      setOpen(false);
      router.push(`/admin/machines/${machine.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === "REAUTH_REQUIRED")
        setReauth(true);
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <h1>机器</h1>
        <Button
          variant="primary"
          onClick={() => {
            setError("");
            setOpen(true);
          }}
        >
          添加机器
        </Button>
      </div>
      <section className="panel">
        <FormError message={resource.error} />
        {resource.error && <Button onClick={resource.refresh}>重新加载</Button>}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>机器</th>
                <th>地址</th>
                <th>状态</th>
                <th>内嵌 sing-box</th>
                <th>daemon</th>
                <th>最近连接</th>
              </tr>
            </thead>
            <tbody>
              {resource.data?.machines.map((machine) => (
                <tr key={machine.id}>
                  <td>
                    <Link
                      className="underline"
                      href={`/admin/machines/${machine.id}`}
                    >
                      {machine.name}
                    </Link>
                    {machine.region && (
                      <span className="subtle block text-xs mt-1">
                        {machine.region}
                      </span>
                    )}
                  </td>
                  <td>{machine.address}</td>
                  <td>
                    <Badge
                      variant={
                        machine.connection === "offline" && !machine.uninstalled
                          ? "destructive"
                          : "secondary"
                      }
                    >
                      {machine.uninstalled
                        ? "已卸载"
                        : connection[machine.connection]}
                    </Badge>
                  </td>
                  <td>{machine.coreVersion ?? "—"}</td>
                  <td>{machine.daemonVersion ?? "—"}</td>
                  <td>
                    {machine.lastSeenAt ? date(machine.lastSeenAt) : "尚未连接"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!resource.data?.machines.length && (
            <div className="empty-state">
              {resource.loading
                ? "正在加载…"
                : resource.error
                  ? "未能加载机器"
                  : "尚未添加机器"}
            </div>
          )}
        </div>
      </section>
      {open && (
        <Modal
          title="添加机器"
          open
          onClose={() => {
            if (!busy) setOpen(false);
          }}
        >
          <form className="stack" onSubmit={create}>
            <Input label="名称" name="name" required maxLength={80} />
            <Input
              label="地址"
              name="address"
              required
              maxLength={255}
              placeholder="IP 地址或域名"
            />
            <Input
              label="区域"
              name="region"
              maxLength={80}
              placeholder="例如：东京"
            />
            <FormError message={error} />
            <div className="actions">
              <Button variant="primary" type="submit" loading={busy}>
                创建机器
              </Button>
              <Button
                type="button"
                disabled={busy}
                onClick={() => setOpen(false)}
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
    </>
  );
}

export function MachineDetail({ id }: { id: string }) {
  const router = useRouter();
  const resource = useResource<{ machine: MachineDetailDto }>(
    `/api/v1/admin/machines/${encodeURIComponent(id)}`,
  );
  const machine = resource.data?.machine;
  const [action, setAction] = useState<
    "install" | "token" | "remove" | "uninstall" | null
  >(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reauth, setReauth] = useState(false);
  const [notice, setNotice] = useState("");
  const [uninstallRequestKey, setUninstallRequestKey] = useState("");
  useEffect(() => {
    const interval = setInterval(resource.refresh, 5000);
    return () => clearInterval(interval);
  }, [resource.refresh]);
  async function execute(kind: "token" | "remove" | "inspect" | "uninstall") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const path = `/api/v1/admin/machines/${encodeURIComponent(id)}`;
      if (kind === "remove") {
        await api(path, { method: "DELETE" });
        router.replace("/admin/machines");
        return;
      }
      if (kind === "token")
        await api(`${path}/token`, { method: "POST", body: {} });
      else if (kind === "uninstall") {
        await api(`${path}/uninstall`, {
          method: "POST",
          body: { requestKey: uninstallRequestKey },
        });
        setNotice("卸载任务已排队，请等待机器回报结果。");
      } else {
        await api(`${path}/tasks`, {
          method: "POST",
          body: {
            kind: "inspect",
            requestKey: crypto.randomUUID(),
            includeLogs: true,
            maxLogLines: 100,
            maxBytes: 65_536,
          },
        });
        setNotice("日志任务已排队：最近 100 行，最多 64 KiB。");
      }
      setAction(null);
      await resource.refresh();
    } catch (e) {
      if (e instanceof ApiError && e.code === "REAUTH_REQUIRED")
        setReauth(true);
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  if (!machine)
    return (
      <div className="panel stack">
        <h1>机器详情</h1>
        <FormError message={resource.error} />
        {resource.loading ? (
          <p role="status">正在加载…</p>
        ) : (
          <Button onClick={resource.refresh}>重新加载</Button>
        )}
      </div>
    );
  const uninstallActive = machine.tasks.some(
    (task) =>
      task.kind === "uninstall" &&
      ["queued", "accepted", "running"].includes(task.state),
  );
  const uninstallComplete = machine.uninstalled;
  const mutatingTaskActive = machine.tasks.some(
    (task) =>
      task.kind !== "inspect" &&
      ["queued", "accepted", "running"].includes(task.state),
  );
  function informationChanged(machine: MachineDetailDto, message: string) {
    resource.update({ machine });
    setNotice(message);
  }
  return (
    <>
      <div className="mb-5">
        <Link href="/admin/machines" className="subtle underline">
          机器
        </Link>
      </div>
      <div className="page-heading">
        <div className="actions">
          <h1>{machine.name}</h1>
          <Badge
            variant={
              machine.connection === "offline" && !uninstallComplete
                ? "destructive"
                : "secondary"
            }
          >
            {uninstallComplete ? "已卸载" : connection[machine.connection]}
          </Badge>
        </div>
        {uninstallComplete ? (
          <MachineInformationAction
            machine={machine}
            mode="rebind"
            triggerLabel="重新接入"
            onChanged={informationChanged}
          />
        ) : (
          <Button
            onClick={() => {
              setAction("install");
              setError("");
            }}
          >
            安装与重装命令
          </Button>
        )}
      </div>
      <FormError message={resource.error} />
      {!action && <FormError message={error} />}
      {notice && (
        <p role="status" className="notice mb-6">
          {notice}
        </p>
      )}
      {machine.issue && (
        <p role="alert" className="notice mb-6">
          {machine.issue}
        </p>
      )}
      <ActiveTasks
        tasks={machine.tasks}
        streamConnected={machine.streamConnected}
      />
      <section className="panel">
        <div className="panel-header">
          <h2>机器信息</h2>
          <div className="actions">
            <span className="subtle">{machine.region}</span>
            <MachineInformationAction
              machine={machine}
              mode="edit"
              onChanged={informationChanged}
            />
          </div>
        </div>
        <dl className="grid grid-cols-1 gap-5 sm:grid-cols-3">
          <div>
            <dt className="subtle mb-2">地址</dt>
            <dd>{machine.address}</dd>
          </div>
          <div>
            <dt className="subtle mb-2">daemon 内嵌 sing-box</dt>
            <dd>{machine.coreVersion ?? "未上报"}</dd>
          </div>
          <div>
            <dt className="subtle mb-2">daemon</dt>
            <dd>{machine.daemonVersion ?? "未上报"}</dd>
          </div>
        </dl>
      </section>
      {machine.connection === "waiting" && (
        <section className="panel stack">
          <h2>首次安装</h2>
          <CopyValue value={machine.installCommand} />
        </section>
      )}
      {!uninstallComplete && (
        <MachineConfiguration
          machine={machine}
          onPublished={resource.refresh}
        />
      )}
      {machine.installationId && !uninstallComplete && (
        <MachineUpgrades machine={machine} onQueued={resource.refresh} />
      )}
      {machine.installationId && !uninstallComplete && (
        <MachineResources machine={machine} />
      )}
      {machine.installationId && <MachineUsage machineId={machine.id} />}
      <section className="panel stack">
        <div className="panel-header mb-0">
          <h2>机器 Token</h2>
          <Badge variant="secondary">
            {uninstallComplete ? "仅用于结果确认" : "长期有效"}
          </Badge>
        </div>
        <CopyValue key={machine.token} value={machine.token} />
        <div>
          <Button
            disabled={uninstallActive || uninstallComplete}
            onClick={() => {
              setAction("token");
              setError("");
            }}
          >
            重置 Token
          </Button>
          <MachineInformationAction
            machine={machine}
            mode="rebind"
            onChanged={informationChanged}
          />
        </div>
      </section>
      <section className="panel">
        <div className="panel-header">
          <h2>操作记录与诊断</h2>
          <Button
            loading={busy}
            disabled={
              machine.connection === "waiting" ||
              uninstallComplete ||
              !machine.capabilities.includes("inspect")
            }
            title={
              machine.connection === "waiting"
                ? "机器接入后可获取诊断"
                : uninstallComplete
                  ? "节点程序已卸载"
                  : !machine.capabilities.includes("inspect")
                    ? "当前 daemon 不支持诊断"
                    : undefined
            }
            onClick={() => execute("inspect")}
          >
            获取最近 100 行日志
          </Button>
        </div>
        <TaskHistory tasks={machine.tasks} />
      </section>
      <section className="panel">
        {uninstallComplete && (
          <p role="status" className="notice mb-5">
            节点已报告卸载完成，可继续移除面板记录。
          </p>
        )}
        {uninstallActive && (
          <p role="status" className="notice mb-5">
            正在卸载，请保留机器记录以接收执行结果。
          </p>
        )}
        <div className="actions">
          <Button
            variant="secondary-destructive"
            disabled={
              !machine.capabilities.includes("uninstall") ||
              mutatingTaskActive ||
              uninstallComplete
            }
            title={
              !machine.capabilities.includes("uninstall")
                ? "当前 daemon 未声明卸载能力"
                : mutatingTaskActive
                  ? "请等待当前任务结束"
                  : undefined
            }
            onClick={() => {
              setUninstallRequestKey(crypto.randomUUID());
              setAction("uninstall");
              setError("");
            }}
          >
            卸载节点程序
          </Button>
          <Button
            variant="secondary-destructive"
            disabled={uninstallActive}
            onClick={() => {
              setAction("remove");
              setError("");
            }}
          >
            移除记录
          </Button>
        </div>
      </section>
      {action && (
        <Modal
          title={
            {
              install: "安装与重装命令",
              token: "重置机器 Token",
              remove: "移除记录",
              uninstall: "卸载节点程序",
            }[action]
          }
          open
          onClose={() => {
            if (!busy) setAction(null);
          }}
        >
          <div className="stack">
            {action === "install" ? (
              uninstallComplete ? (
                <>
                  <p>节点已卸载，请先重新接入以生成新安装命令。</p>
                  <MachineInformationAction
                    machine={machine}
                    mode="rebind"
                    triggerLabel="重新接入"
                    onChanged={informationChanged}
                  />
                </>
              ) : (
                <CopyValue value={machine.installCommand} />
              )
            ) : (
              <>
                <p>
                  {action === "token"
                    ? "旧 Token 将立即失效，现有连接会断开。请将新 Token 更新到机器后重新连接。"
                    : action === "uninstall"
                      ? `将停止并移除“${machine.name}”的 daemon 及其内嵌核心，代理连接会中断。面板记录将保留以接收卸载结果，完成后可另行移除记录。`
                      : `仅移除“${machine.name}”在面板中的记录，机器上的程序不会被卸载。`}
                </p>
                <FormError message={error} />
                {action === "uninstall" && mutatingTaskActive && (
                  <p className="subtle">
                    另一项节点操作正在进行，请等待任务结束。
                  </p>
                )}
                <div className="actions">
                  <Button
                    variant="destructive"
                    loading={busy}
                    disabled={
                      action === "uninstall"
                        ? mutatingTaskActive || uninstallComplete
                        : uninstallActive
                    }
                    onClick={() => execute(action)}
                  >
                    {action === "token"
                      ? "重置 Token"
                      : action === "uninstall"
                        ? "开始卸载"
                        : "移除记录"}
                  </Button>
                  <Button disabled={busy} onClick={() => setAction(null)}>
                    取消
                  </Button>
                </div>
              </>
            )}
          </div>
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
    </>
  );
}
