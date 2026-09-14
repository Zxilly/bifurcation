"use client";

import {
  LayerCard,
  Table,
  Banner,
  Button,
  Input,
  Badge,
  Tabs,
  Select,
  LinkButton,
} from "@cloudflare/kumo";
import { ResourceState } from "@/components/resource-state";
import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { CoreHealth, TaskKind } from "@bifurcation/rpc";
import { ArrowLeftIcon, ArrowClockwiseIcon } from "@phosphor-icons/react";
import { maintenanceInfo } from "@/contracts/maintenance";
import { formatBytes } from "@/features/usage/format";
import {
  ConnectionBadge,
  coreHealthNames,
  percent,
  reportedAt,
} from "./status";
import {
  MachineConnection,
  TaskState,
  type MachineDetail,
} from "@bifurcation/rpc/panel/machines";
import { Modal, FormError } from "@/components/modal";
import { CopyValue } from "@/components/secret-result";
import { Reauthenticate } from "@/features/identity/reauth";
import { ApiError, errorMessage } from "@/features/shared/api";
import { panel } from "@/features/shared/rpc";
import { useResource } from "@/features/shared/use-resource";
import { MachineConfiguration } from "@/features/configuration/machine-configuration";
import { MachineResources } from "./resources";
import { MachineUsage } from "@/features/usage/overview";
import { MachineUpgrades } from "./upgrades";
import { ActiveTasks, TaskHistory } from "./tasks";
import { MachineInformationAction } from "./information";

const ACTIVE_STATES = new Set<TaskState>([
  TaskState.QUEUED,
  TaskState.ACCEPTED,
  TaskState.RUNNING,
]);
const detailTabs = [
  { value: "overview", label: "概览" },
  { value: "usage", label: "用量" },
  { value: "activity", label: "操作记录" },
  { value: "maintenance", label: "接入与维护" },
];
export function Machines() {
  const router = useRouter();
  const resource = useResource(
    "machines",
    () => panel.machines.listMachines({}),
    { refreshInterval: 10_000 },
  );
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const allMachines = resource.data?.machines ?? [];
  const search = query.trim().toLocaleLowerCase();
  const filtered = allMachines.filter((machine) => {
    const status = machine.uninstalled
      ? "uninstalled"
      : String(machine.connection);
    return (
      (filter === "all" || status === filter) &&
      [machine.name, machine.address, machine.region, ...machine.tags].some(
        (value) => value.toLocaleLowerCase().includes(search),
      )
    );
  });
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reauth, setReauth] = useState(false);
  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const { machine } = await panel.machines.createMachine({
        name: String(values.get("name")),
        address: String(values.get("address")),
        region: String(values.get("region") ?? ""),
        tags: String(values.get("tags") ?? "")
          .split(/[,，\s]+/)
          .filter(Boolean),
      });
      setOpen(false);
      router.push(`/admin/machines/${machine!.id}`);
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
        <div>
          <h1>机器</h1>
          <p className="subtle mt-2">
            {allMachines.length} 台机器 ·{" "}
            {
              allMachines.filter(
                (m) =>
                  !m.uninstalled && m.connection === MachineConnection.ONLINE,
              ).length
            }{" "}
            台在线
          </p>
        </div>
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
      <section className="panel-section stack">
        <FormError message={resource.error} />
        <div className="machine-list-toolbar">
          <Input
            aria-label="搜索机器"
            placeholder="搜索名称、地址、地区或标签"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <Select
            aria-label="机器状态"
            value={filter}
            onValueChange={(value) => setFilter(String(value))}
            items={{
              all: "全部状态",
              [MachineConnection.ONLINE]: "在线",
              [MachineConnection.OFFLINE]: "失联",
              [MachineConnection.WAITING]: "待接入",
              uninstalled: "已卸载",
            }}
          />
          <Button
            variant="ghost"
            icon={ArrowClockwiseIcon}
            onClick={resource.refresh}
          >
            刷新
          </Button>
          {(query || filter !== "all") && (
            <Button
              variant="ghost"
              onClick={() => {
                setQuery("");
                setFilter("all");
              }}
            >
              清除筛选
            </Button>
          )}
          <span className="subtle text-xs ml-auto">
            {filtered.length} / {allMachines.length} 台
          </span>
        </div>
        <LayerCard className="min-w-0 overflow-x-auto p-0">
          <Table className="tabular-nums md:min-w-[850px]">
            <Table.Header>
              <Table.Row>
                <Table.Head>机器 / 地址</Table.Head>
                <Table.Head>状态</Table.Head>
                <Table.Head className="hidden md:table-cell">
                  系统 / 版本
                </Table.Head>
                <Table.Head className="hidden md:table-cell">资源</Table.Head>
                <Table.Head className="hidden md:table-cell text-right">
                  代理连接
                </Table.Head>
                <Table.Head className="hidden md:table-cell">
                  最近上报
                </Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {filtered.map((machine) => (
                <Table.Row key={machine.id}>
                  <Table.Cell className="max-w-80">
                    <Link
                      className="text-kumo-link font-medium hover:underline break-words"
                      href={`/admin/machines/${machine.id}`}
                    >
                      {machine.name}
                    </Link>
                    <p className="text-xs mt-1 break-all">{machine.address}</p>
                    {(machine.region || machine.tags.length > 0) && (
                      <div className="flex flex-wrap items-center gap-1.5 mt-2">
                        {machine.region && (
                          <span className="subtle text-xs">
                            {machine.region}
                          </span>
                        )}
                        {machine.tags.map((tag) => (
                          <Badge key={tag} variant="secondary">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    )}
                    <dl className="md:hidden grid gap-2 mt-4 text-xs">
                      <div>
                        <dt className="subtle">系统</dt>
                        <dd className="mt-0.5">
                          {[machine.os, machine.arch]
                            .filter(Boolean)
                            .join(" / ") || "未上报"}
                        </dd>
                      </div>
                      <div>
                        <dt className="subtle">版本</dt>
                        <dd className="mt-0.5">
                          daemon {machine.daemonVersion ?? "—"}
                          <br />
                          sing-box {machine.coreVersion ?? "—"}
                        </dd>
                      </div>
                      <div>
                        <dt className="subtle">资源</dt>
                        <dd className="mt-0.5">
                          CPU {percent(machine.resources?.cpuUsagePercent)} ·
                          内存{" "}
                          {machine.resources?.memoryUsedBytes == null
                            ? "未上报"
                            : formatBytes(machine.resources.memoryUsedBytes)}
                        </dd>
                      </div>
                      <div>
                        <dt className="subtle">代理连接</dt>
                        <dd className="mt-0.5">
                          {machine.resources?.connections?.toLocaleString(
                            "zh-CN",
                          ) ?? "未上报"}
                        </dd>
                      </div>
                      <div>
                        <dt className="subtle">最近上报</dt>
                        <dd className="mt-0.5">
                          {machine.lastSeenAt
                            ? reportedAt(machine.lastSeenAt)
                            : "尚未连接"}
                        </dd>
                      </div>
                    </dl>
                  </Table.Cell>
                  <Table.Cell className="align-top md:align-middle">
                    <ConnectionBadge
                      connection={machine.connection}
                      uninstalled={machine.uninstalled}
                    />
                    {!machine.uninstalled && (
                      <p
                        className={`text-xs mt-2 ${machine.coreHealth === CoreHealth.UNHEALTHY ? "text-kumo-danger" : "subtle"}`}
                      >
                        代理{coreHealthNames[machine.coreHealth] ?? "未上报"}
                      </p>
                    )}
                    {machine.activeTaskCount > 0 && (
                      <p className="text-xs mt-1">
                        {machine.activeTaskCount} 项任务进行中
                      </p>
                    )}
                  </Table.Cell>
                  <Table.Cell className="hidden md:table-cell">
                    <p>
                      {[machine.os, machine.arch].filter(Boolean).join(" / ") ||
                        "未上报"}
                    </p>
                    <p className="subtle text-xs mt-1">
                      daemon {machine.daemonVersion ?? "—"}
                    </p>
                    <p className="subtle text-xs mt-1">
                      sing-box {machine.coreVersion ?? "—"}
                    </p>
                  </Table.Cell>
                  <Table.Cell className="hidden md:table-cell">
                    <p>CPU {percent(machine.resources?.cpuUsagePercent)}</p>
                    <p className="subtle text-xs mt-1">
                      内存{" "}
                      {machine.resources?.memoryUsedBytes == null
                        ? "未上报"
                        : formatBytes(machine.resources.memoryUsedBytes)}
                    </p>
                  </Table.Cell>
                  <Table.Cell className="hidden md:table-cell text-right">
                    {machine.resources?.connections?.toLocaleString("zh-CN") ??
                      "—"}
                  </Table.Cell>
                  <Table.Cell className="hidden md:table-cell text-xs">
                    {machine.lastSeenAt
                      ? reportedAt(machine.lastSeenAt)
                      : "尚未连接"}
                  </Table.Cell>
                </Table.Row>
              ))}
              {filtered.length === 0 && (
                <Table.Row>
                  <Table.Cell colSpan={6}>
                    <ResourceState
                      loading={resource.loading}
                      title={
                        resource.loading
                          ? "正在加载…"
                          : resource.error
                            ? "未能加载机器"
                            : allMachines.length
                              ? "没有匹配的机器"
                              : "尚未添加机器"
                      }
                    />
                    {!resource.loading && !resource.error && (
                      <p className="subtle text-center pb-6">
                        {allMachines.length
                          ? "调整搜索词或清除筛选后重试。"
                          : "添加机器后，使用安装命令接入节点。"}
                      </p>
                    )}
                  </Table.Cell>
                </Table.Row>
              )}
            </Table.Body>
          </Table>
        </LayerCard>
        <p className="subtle text-xs">
          资源数据为节点最近上报值；失联机器的数值不会实时更新。
        </p>
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
            <Input
              label="节点标签"
              name="tags"
              placeholder="ai, game"
              description="逗号分隔，订阅按标签生成节点组。"
            />
            <FormError message={error} />
            <div className="mt-8 flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                取消
              </Button>
              <Button variant="primary" type="submit" loading={busy}>
                创建机器
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

export function MachineDetailPage({ id }: { id: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const tab = detailTabs.some((item) => item.value === requestedTab)
    ? requestedTab!
    : "overview";
  function selectTab(value: string) {
    const url = new URL(window.location.href);
    if (value === "overview") url.searchParams.delete("tab");
    else url.searchParams.set("tab", value);
    window.history.pushState(null, "", url);
  }
  const resource = useResource(
    `machine:${id}`,
    () => panel.machines.getMachine({ machineId: id }).then((r) => r.machine!),
    { refreshInterval: 5_000 },
  );
  const machine = resource.data;
  const [action, setAction] = useState<
    "install" | "token" | "remove" | "uninstall" | null
  >(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reauth, setReauth] = useState(false);
  const [notice, setNotice] = useState("");
  const [uninstallRequestKey, setUninstallRequestKey] = useState("");
  async function execute(kind: "token" | "remove" | "inspect" | "uninstall") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (kind === "remove") {
        await panel.machines.deleteMachine({ machineId: id });
        router.replace("/admin/machines");
        return;
      }
      if (kind === "token")
        await panel.machines.resetMachineToken({ machineId: id });
      else if (kind === "uninstall") {
        await panel.machines.uninstallMachine({
          machineId: id,
          requestKey: uninstallRequestKey,
        });
        setNotice("卸载任务已排队，请等待机器回报结果。");
      } else {
        await panel.machines.enqueueInspectTask({
          machineId: id,
          requestKey: crypto.randomUUID(),
          includeLogs: true,
          maxLogLines: 100,
          maxBytes: 65_536,
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
      <LayerCard render={<div />} className="panel stack">
        <h1>机器详情</h1>
        <FormError message={resource.error} />
        {resource.loading ? (
          <p role="status">正在加载…</p>
        ) : (
          <Button onClick={resource.refresh}>重新加载</Button>
        )}
      </LayerCard>
    );
  const uninstallActive = machine.tasks.some(
    (task) => task.kind === TaskKind.UNINSTALL && ACTIVE_STATES.has(task.state),
  );
  const uninstallComplete = machine.uninstalled;
  const mutatingTaskActive = machine.tasks.some(
    (task) => task.kind !== TaskKind.INSPECT && ACTIVE_STATES.has(task.state),
  );
  function informationChanged(machine: MachineDetail, message: string) {
    resource.update(machine);
    setNotice(message);
  }
  const maintenance = maintenanceInfo(
    machine.maintenanceStatus,
    machine.capabilities.includes(TaskKind.UPGRADE_DAEMON),
  );
  const uninstallSupport = maintenanceInfo(
    machine.maintenanceStatus,
    machine.capabilities.includes(TaskKind.UNINSTALL),
  );
  const canInspect =
    machine.connection !== MachineConnection.WAITING &&
    !uninstallComplete &&
    machine.capabilities.includes(TaskKind.INSPECT);
  return (
    <>
      <div className="machine-workspace">
        <Link
          href="/admin/machines"
          className="subtle inline-flex items-center gap-1.5 hover:underline mb-4"
          aria-label="返回机器列表"
        >
          <ArrowLeftIcon size={14} aria-hidden />
          机器
        </Link>
        <div className="machine-heading">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="break-words min-w-0">{machine.name}</h1>
              <ConnectionBadge
                connection={machine.connection}
                uninstalled={uninstallComplete}
              />
              {!uninstallComplete && (
                <Badge
                  variant={
                    machine.coreHealth === CoreHealth.HEALTHY
                      ? "success"
                      : machine.coreHealth === CoreHealth.UNHEALTHY
                        ? "error"
                        : "secondary"
                  }
                >
                  代理{coreHealthNames[machine.coreHealth] ?? "未上报"}
                </Badge>
              )}
            </div>
            <div className="machine-identity-line">
              <span className="break-all">{machine.address}</span>
              {machine.region && (
                <span className="subtle">{machine.region}</span>
              )}
              {machine.tags.map((tag) => (
                <Badge variant="secondary" key={tag}>
                  {tag}
                </Badge>
              ))}
            </div>
          </div>
          <div className="actions shrink-0">
            <MachineInformationAction
              machine={machine}
              mode="edit"
              onChanged={informationChanged}
            />
            {uninstallComplete ? (
              <MachineInformationAction
                machine={machine}
                mode="rebind"
                triggerLabel="重新接入"
                onChanged={informationChanged}
              />
            ) : (
              <LinkButton
                variant="primary"
                href={`/admin/machines/${id}/configuration`}
              >
                发布配置
              </LinkButton>
            )}
          </div>
        </div>
        <FormError message={resource.error} />
        {!action && <FormError message={error} />}
        {notice && (
          <Banner role="status" variant="secondary">
            {notice}
          </Banner>
        )}
        {machine.issue && (
          <Banner role="alert" variant="error">
            {machine.issue}
          </Banner>
        )}
        <ActiveTasks
          tasks={machine.tasks}
          streamConnected={machine.streamConnected}
        />
        <Tabs
          variant="underline"
          value={tab}
          onValueChange={selectTab}
          className="machine-tabs"
          labels={{
            scrollStart: "向左查看更多标签",
            scrollEnd: "向右查看更多标签",
          }}
          tabs={detailTabs.map((item) => ({
            ...item,
            render: (
              <button
                id={`machine-tab-${item.value}`}
                aria-controls={`machine-panel-${item.value}`}
              />
            ),
          }))}
        />
        <div
          id={`machine-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`machine-tab-${tab}`}
          tabIndex={0}
          className="machine-tab-content"
        >
          {tab === "overview" && (
            <>
              {machine.connection === MachineConnection.WAITING && (
                <LayerCard render={<section />} className="machine-section">
                  <div className="machine-section-heading">
                    <h2>首次安装</h2>
                    <Badge variant="secondary">等待接入</Badge>
                  </div>
                  <p className="subtle mb-4">
                    在 Linux 节点执行安装命令，接入后会自动开始上报运行状态。
                  </p>
                  <CopyValue value={machine.installCommand} />
                </LayerCard>
              )}
              {machine.installationId && !uninstallComplete && (
                <MachineResources machine={machine} />
              )}
              <div className="machine-overview-grid">
                <LayerCard render={<section />} className="machine-section">
                  <div className="machine-section-heading">
                    <h2>机器信息</h2>
                  </div>
                  <dl className="machine-facts">
                    <div>
                      <dt>管理连接</dt>
                      <dd>
                        {uninstallComplete
                          ? "已卸载"
                          : machine.streamConnected
                            ? "已连接"
                            : machine.installationId
                              ? "连接中断"
                              : "等待接入"}
                      </dd>
                    </div>
                    <div>
                      <dt>操作系统</dt>
                      <dd>
                        {[machine.os, machine.arch]
                          .filter(Boolean)
                          .join(" / ") || "未上报"}
                      </dd>
                    </div>
                    <div>
                      <dt>daemon</dt>
                      <dd>{machine.daemonVersion ?? "未上报"}</dd>
                    </div>
                    <div>
                      <dt>内嵌 sing-box</dt>
                      <dd>{machine.coreVersion ?? "未上报"}</dd>
                    </div>
                    <div>
                      <dt>维护方式</dt>
                      <dd>
                        {machine.installationId
                          ? maintenance.label
                          : "接入后确认"}
                      </dd>
                    </div>
                  </dl>
                  <Button
                    variant="ghost"
                    className="mt-4"
                    onClick={() => selectTab("maintenance")}
                  >
                    管理接入与维护
                  </Button>
                </LayerCard>
                {!uninstallComplete ? (
                  <MachineConfiguration machine={machine} />
                ) : (
                  <LayerCard render={<section />} className="machine-section">
                    <h2>节点已卸载</h2>
                    <p className="subtle mt-3">
                      历史用量与操作记录仍然保留。可重新接入节点，或在接入与维护中移除记录。
                    </p>
                    <Button
                      className="mt-4"
                      onClick={() => selectTab("maintenance")}
                    >
                      管理记录
                    </Button>
                  </LayerCard>
                )}
              </div>
            </>
          )}
          {tab === "usage" &&
            (machine.installationId ? (
              <MachineUsage machineId={machine.id} />
            ) : (
              <ResourceState loading={false} title="接入后开始统计代理用量" />
            ))}
          {tab === "activity" && (
            <section className="panel-section stack">
              <div className="machine-section-heading">
                <div>
                  <h2>操作记录与诊断</h2>
                  <p className="subtle text-xs mt-1">
                    查看执行结果与节点最近日志。
                  </p>
                </div>
                <Button
                  loading={busy}
                  disabled={!canInspect}
                  title={
                    !canInspect ? "节点接入并支持诊断后可获取日志" : undefined
                  }
                  onClick={() => execute("inspect")}
                >
                  获取最近 100 行日志
                </Button>
              </div>
              <TaskHistory tasks={machine.tasks} />
            </section>
          )}
          {tab === "maintenance" && (
            <>
              <div className="machine-maintenance-grid">
                {machine.installationId && !uninstallComplete ? (
                  <MachineUpgrades
                    machine={machine}
                    onQueued={resource.refresh}
                  />
                ) : (
                  <LayerCard render={<section />} className="machine-section">
                    <h2>{uninstallComplete ? "节点已卸载" : "等待节点接入"}</h2>
                    <p className="subtle mt-3">
                      {uninstallComplete
                        ? "节点已报告卸载完成，可继续移除面板记录。"
                        : "执行安装命令后，面板将显示节点版本和维护方式。"}
                    </p>
                  </LayerCard>
                )}
                <LayerCard render={<section />} className="machine-section">
                  <div className="machine-section-heading">
                    <h2>机器 Token</h2>
                    <Badge variant="secondary">
                      {uninstallComplete ? "仅用于结果确认" : "长期有效"}
                    </Badge>
                  </div>
                  <p className="subtle mb-4">
                    用于本机连接面板。重置后，需在节点上同步新 Token。
                  </p>
                  <CopyValue key={machine.token} value={machine.token} />
                  <div className="actions mt-4">
                    <Button
                      disabled={uninstallActive || uninstallComplete}
                      onClick={() => {
                        setAction("token");
                        setError("");
                      }}
                    >
                      重置 Token
                    </Button>
                  </div>
                </LayerCard>
              </div>
              <LayerCard render={<section />} className="machine-section">
                <div className="machine-section-heading">
                  <h2>安装与绑定</h2>
                </div>
                <div className="machine-operation-row">
                  <div>
                    <h3 className="font-medium">安装与重装命令</h3>
                    <p className="subtle mt-1">
                      在 Linux 主机安装为 systemd
                      服务。容器节点通过镜像管理程序。
                    </p>
                  </div>
                  {uninstallComplete ? (
                    <span className="subtle text-xs">重新接入后生成新命令</span>
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
                <div className="machine-operation-row">
                  <div>
                    <h3 className="font-medium">替换安装实例</h3>
                    <p className="subtle mt-1">
                      更换机器或重新绑定；旧实例会失去访问权限，并生成新 Token。
                    </p>
                  </div>
                  <MachineInformationAction
                    machine={machine}
                    mode="rebind"
                    onChanged={informationChanged}
                  />
                </div>
              </LayerCard>
              <LayerCard render={<section />} className="machine-section">
                <div className="machine-section-heading">
                  <h2>卸载与移除</h2>
                </div>
                {uninstallActive && (
                  <Banner role="status" variant="secondary">
                    正在卸载，请保留机器记录以接收执行结果。
                  </Banner>
                )}
                <div className="machine-operation-row">
                  <div>
                    <h3 className="font-medium">卸载节点程序</h3>
                    <p className="subtle mt-1">
                      停止代理并清理安装文件，保留面板记录以接收执行结果。
                    </p>
                    {!uninstallSupport.available && !uninstallComplete && (
                      <p className="subtle text-xs mt-2">
                        {uninstallSupport.description}
                      </p>
                    )}
                    {mutatingTaskActive && (
                      <p className="text-kumo-warning mt-1">
                        请等待当前节点任务结束。
                      </p>
                    )}
                  </div>
                  <Button
                    variant="secondary-destructive"
                    disabled={
                      !uninstallSupport.available ||
                      mutatingTaskActive ||
                      uninstallComplete
                    }
                    onClick={() => {
                      setUninstallRequestKey(crypto.randomUUID());
                      setAction("uninstall");
                      setError("");
                    }}
                  >
                    卸载节点程序
                  </Button>
                </div>
                <div className="machine-operation-row">
                  <div>
                    <h3 className="font-medium">移除面板记录</h3>
                    <p className="subtle mt-1">
                      移除面板中的机器记录；节点上的程序不会被卸载。
                    </p>
                  </div>
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
              </LayerCard>
            </>
          )}
        </div>
      </div>
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
                <div className="mt-8 flex flex-wrap justify-end gap-2">
                  <Button disabled={busy} onClick={() => setAction(null)}>
                    取消
                  </Button>
                  <Button
                    variant="destructive"
                    loading={busy}
                    disabled={
                      action === "uninstall"
                        ? mutatingTaskActive ||
                          uninstallComplete ||
                          !uninstallSupport.available
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
