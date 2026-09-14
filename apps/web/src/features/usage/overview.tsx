"use client";

import { Banner, LayerCard, Collapsible, LinkButton } from "@cloudflare/kumo";
import { ResourceState } from "@/components/resource-state";
import { ResourceFeedback } from "@/components/resource-feedback";
import { Grain, type Usage } from "@bifurcation/rpc/panel/usage";
import { MachineConnection } from "@bifurcation/rpc/panel/machines";
import { UserStatus } from "@bifurcation/rpc/panel/types";
import { resourceKeys } from "@/features/shared/keys";
import { panel } from "@/features/shared/rpc";
import { useResource } from "@/features/shared/use-resource";
import { formatGiB, formatRate, share } from "./format";
import { PeriodPicker, useUsagePeriod } from "./period";
import { periodRange, usageKey, usageRequest } from "./range";
import { Trend } from "./trend";
import { DataQuality, GroupUsageTable, UserMachineTable } from "./usage-table";
import { UsageSummary } from "./summary";

const dayLabel = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
  timeZone: "Asia/Shanghai",
});
const minuteLabel = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Shanghai",
});

function UsageMetadata({ usage }: { usage: Usage }) {
  const previous = usage.previousPeriod;
  if (!previous) return null;
  return (
    <UsageSummary
      peak={usage.peakMinuteAverageBytesPerSecond ?? null}
      previous={{
        start: previous.previousStart,
        end: previous.previousEnd,
        bytes: previous.hasData
          ? previous.uploadBytes + previous.downloadBytes
          : null,
        incomplete: previous.incomplete,
      }}
      changePercent={previous.changePercent ?? null}
      currentIncomplete={usage.incomplete}
      currentInProgress={previous.currentPeriodInProgress}
    />
  );
}

function UsageTrend({ usage }: { usage: Usage }) {
  return (
    <>
      {!!usage.points.length && <UsageMetadata usage={usage} />}
      {(usage.estimated || usage.incomplete) && (
        <div className="actions">
          <DataQuality
            estimated={usage.estimated}
            incomplete={usage.incomplete}
          />
        </div>
      )}
      {usage.incomplete && (
        <p className="subtle">部分统计存在缺口，显示值可能低于实际用量。</p>
      )}
      <Trend
        kind={usage.grain === Grain.MINUTE ? "line" : "bar"}
        points={usage.points.map((point) => ({
          label: (usage.grain === Grain.MINUTE ? minuteLabel : dayLabel).format(
            Number(point.bucketStart),
          ),
          uploadBytes: point.uploadBytes,
          downloadBytes: point.downloadBytes,
        }))}
      />
    </>
  );
}

export function PersonalOverview() {
  const period = useUsagePeriod();
  const resource = useResource(
    usageKey(period.range),
    () => panel.me.getMyUsage(usageRequest(period.range)).then((r) => r.usage!),
    { refreshInterval: 30_000 },
  );
  const today = periodRange("today", period.month, period.now);
  const todayUsage = useResource(
    usageKey(today, "today"),
    () => panel.me.getMyUsage(usageRequest(today)).then((r) => r.usage!),
    { refreshInterval: 30_000 },
  );
  const usage = resource.data;
  const quota = usage?.currentMonth;
  const totalToday = todayUsage.data?.points.length
    ? todayUsage.data.uploadBytes + todayUsage.data.downloadBytes
    : null;
  const remaining =
    quota?.limitBytes !== undefined && quota !== undefined
      ? quota.limitBytes - quota.usedBytes
      : null;
  const hasCurrentUsage =
    !!quota &&
    (quota.usedBytes > 0n ||
      !!todayUsage.data?.points.length ||
      (period.period === "month" &&
        quota.period === period.month &&
        !!usage?.points.length));
  return (
    <div className="overview-workspace">
      <div className="page-heading">
        <h1>我的概览</h1>
        <PeriodPicker value={period} />
      </div>
      <div className="mb-6 space-y-3">
        <p className="subtle">
          统计按上海时区计算，上下行合计；额度按自然月重置。
        </p>
        <LinkButton href="/subscription">管理我的订阅</LinkButton>
        <ResourceFeedback {...resource} onRetry={resource.refresh} />
        <ResourceFeedback {...todayUsage} onRetry={todayUsage.refresh} />
      </div>
      {(quota?.blocked || !!quota?.warning) && (
        <Banner role="status" variant="alert" className="mb-6">
          {quota.blocked
            ? "本月额度已用尽，代理接入受限。下月 1 日 00:00（上海时间）重置额度，或联系管理员调整。手工禁用的账号不会随额度重置自动启用。"
            : `本月额度已使用 ${quota.warning}% 以上。`}
        </Banner>
      )}
      <div className="metric-row">
        <LayerCard render={<section />} className="panel">
          <h2>本月已用</h2>
          <strong className="metric-value">
            {quota && hasCurrentUsage ? formatGiB(quota.usedBytes) : "—"}
          </strong>
          {quota && (
            <span className="subtle">
              {quota.limitBytes === undefined
                ? "不限量"
                : quota.limitBytes === 0n
                  ? "额度为 0，暂无可用流量"
                  : hasCurrentUsage
                    ? `额度 ${formatGiB(quota.limitBytes)} · 已使用 ${share(quota.usedBytes, quota.limitBytes)}%`
                    : `额度 ${formatGiB(quota.limitBytes)} · 暂无统计记录`}
            </span>
          )}
        </LayerCard>
        <LayerCard render={<section />} className="panel">
          <h2>本月剩余</h2>
          <strong className="metric-value">
            {!quota
              ? "—"
              : remaining === null
                ? "不限量"
                : quota.limitBytes === 0n
                  ? "0 GiB"
                  : !hasCurrentUsage
                    ? "—"
                    : formatGiB(remaining > 0n ? remaining : 0n)}
          </strong>
          {quota && <span className="subtle">{quota.period} · 上海时区</span>}
        </LayerCard>
        <LayerCard render={<section />} className="panel">
          <h2>今日用量</h2>
          <strong className="metric-value">
            {totalToday === null ? "—" : formatGiB(totalToday)}
          </strong>
          {todayUsage.data && totalToday !== null && (
            <span className="subtle">
              上传 {formatGiB(todayUsage.data.uploadBytes)} · 下载{" "}
              {formatGiB(todayUsage.data.downloadBytes)}
            </span>
          )}
        </LayerCard>
      </div>
      <section className="panel-section stack">
        <div className="panel-header">
          <h2>{period.period === "today" ? "今天用了多少" : "每天用了多少"}</h2>
          {!!usage?.points.length && (
            <span className="subtle text-xs">
              共 {formatGiB(usage.uploadBytes + usage.downloadBytes)}
            </span>
          )}
        </div>
        {usage ? (
          <UsageTrend usage={usage} />
        ) : (
          <ResourceState
            loading={resource.loading}
            title={resource.loading ? "正在加载用量…" : "用量暂时无法加载"}
          />
        )}
      </section>
      {!!usage?.groups.length && (
        <section className="panel-section stack">
          <h2>用在哪些节点</h2>
          <GroupUsageTable groups={usage.groups} dimension="machine" />
        </section>
      )}
    </div>
  );
}

export function AdminUsageOverview() {
  const period = useUsagePeriod();
  const resource = useResource(
    usageKey(period.range, "admin"),
    () =>
      panel.usage.queryUsage(usageRequest(period.range)).then((r) => r.usage!),
    { refreshInterval: 30_000 },
  );
  const machines = useResource(
    resourceKeys.machines,
    () => panel.machines.listMachines({}),
    {
      refreshInterval: 30_000,
    },
  );
  const users = useResource(resourceKeys.users, () => panel.users.listUsers({}), {
    refreshInterval: 30_000,
  });
  const usage = resource.data;
  return (
    <div className="overview-workspace admin-overview">
      <div className="page-heading">
        <h1>管理概览</h1>
        <PeriodPicker value={period} />
      </div>
      <div className="mb-6 space-y-3">
        <p className="subtle">所选期间 · 上海时区 · 上传 + 下载</p>
        <ResourceFeedback {...resource} onRetry={resource.refresh} />
        <ResourceFeedback {...machines} onRetry={machines.refresh} />
        <ResourceFeedback {...users} onRetry={users.refresh} />
        {!!machines.data?.machines.some(
          (machine) =>
            machine.connection === MachineConnection.OFFLINE &&
            !machine.uninstalled,
        ) && (
          <Banner variant="alert" role="status">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p>
                有机器失联，当前运行状态无法确认；面板失联不代表代理已停止。
              </p>
              <LinkButton href="/admin/machines">查看节点状态</LinkButton>
            </div>
          </Banner>
        )}
      </div>
      <div className="metric-row">
        <LayerCard render={<section />} className="panel">
          <h2>在线机器</h2>
          <strong className="metric-value">
            {machines.data
              ? `${machines.data.machines.filter((machine) => machine.connection === MachineConnection.ONLINE && !machine.uninstalled).length} / ${machines.data.machines.length}`
              : "—"}
          </strong>
        </LayerCard>
        <LayerCard render={<section />} className="panel">
          <h2>所选期间流量</h2>
          <strong className="metric-value">
            {usage?.points.length
              ? formatGiB(usage.uploadBytes + usage.downloadBytes)
              : "—"}
          </strong>
          {!!usage?.points.length && (
            <span className="subtle">
              上传 {formatGiB(usage.uploadBytes)} · 下载{" "}
              {formatGiB(usage.downloadBytes)}
            </span>
          )}
        </LayerCard>
        <LayerCard render={<section />} className="panel">
          <h2>分钟平均峰值</h2>
          <strong className="metric-value">
            {usage?.peakMinuteAverageBytesPerSecond == null
              ? "—"
              : formatRate(usage.peakMinuteAverageBytesPerSecond)}
          </strong>
          <span className="subtle">所选期间 · 仅完整分钟</span>
        </LayerCard>
        <LayerCard render={<section />} className="panel">
          <h2>启用用户</h2>
          <strong className="metric-value">
            {users.data
              ? `${users.data.users.filter((user) => user.status === UserStatus.ACTIVE).length} / ${users.data.users.length}`
              : "—"}
          </strong>
        </LayerCard>
      </div>
      <section className="panel-section stack">
        <h2>上下行趋势</h2>
        {usage ? (
          <UsageTrend usage={usage} />
        ) : (
          <ResourceState
            loading={resource.loading}
            title={resource.loading ? "正在加载用量…" : "用量暂时无法加载"}
          />
        )}
      </section>
      {!!usage?.groups.length && (
        <section className="panel-section stack">
          <h2>节点用量</h2>
          <GroupUsageTable groups={usage.groups} dimension="machine" />
        </section>
      )}
      {!!usage?.groups.length && (
        <section className="panel-section stack">
          <h2>用户用量</h2>
          <GroupUsageTable groups={usage.groups} dimension="user" />
        </section>
      )}
    </div>
  );
}

export function UserNodeUsage() {
  const period = useUsagePeriod();
  const resource = useResource(
    usageKey(period.range, "admin"),
    () =>
      panel.usage.queryUsage(usageRequest(period.range)).then((r) => r.usage!),
    { refreshInterval: 30_000 },
  );
  return (
    <section className="panel-section stack">
      <div className="panel-header flex-wrap">
        <h2>用户 × 节点用量</h2>
        <PeriodPicker value={period} />
      </div>
      <ResourceFeedback {...resource} onRetry={resource.refresh} />
      {resource.data ? (
        <>
          <div className="actions">
            <DataQuality
              estimated={resource.data.estimated}
              incomplete={resource.data.incomplete}
            />
          </div>
          <UserMachineTable groups={resource.data.groups} />
          {!!resource.data.points.length && (
            <UsageMetadata usage={resource.data} />
          )}
        </>
      ) : (
        <ResourceState
          loading={resource.loading}
          title={resource.loading ? "正在加载用量…" : "用量暂时无法加载"}
        />
      )}
    </section>
  );
}

export function MachineUsage({ machineId }: { machineId: string }) {
  const period = useUsagePeriod();
  const resource = useResource(
    usageKey(period.range, `machine:${machineId}`),
    () =>
      panel.usage
        .queryUsage({ ...usageRequest(period.range), machineId })
        .then((r) => r.usage!),
    { refreshInterval: 30_000 },
  );
  return (
    <section className="panel-section stack">
      <div className="panel-header flex-wrap">
        <h2>代理用量</h2>
        <PeriodPicker value={period} />
      </div>
      <ResourceFeedback {...resource} onRetry={resource.refresh} />
      {resource.data ? (
        <>
          <div className="actions mb-4 subtle">
            {resource.data.points.length ? (
              <>
                <span>上传 {formatGiB(resource.data.uploadBytes)}</span>
                <span>下载 {formatGiB(resource.data.downloadBytes)}</span>
              </>
            ) : (
              <span>暂无统计记录</span>
            )}
          </div>
          <UsageTrend usage={resource.data} />
          <Collapsible.Root className="mt-4">
            <Collapsible.DefaultTrigger className="cursor-pointer py-2">
              用户分布
            </Collapsible.DefaultTrigger>
            <Collapsible.DefaultPanel>
              <GroupUsageTable groups={resource.data.groups} dimension="user" />
            </Collapsible.DefaultPanel>
          </Collapsible.Root>
        </>
      ) : (
        <ResourceState
          loading={resource.loading}
          title={resource.loading ? "正在加载用量…" : "用量暂时无法加载"}
        />
      )}
    </section>
  );
}
