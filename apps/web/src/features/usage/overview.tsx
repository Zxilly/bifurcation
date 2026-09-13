"use client";

import { useEffect } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import type { UsageDto } from "@/contracts/usage";
import type { MachineDto } from "@/contracts/machines";
import type { UserDto } from "@/contracts/identity";
import { FormError } from "@/components/modal";
import { useResource } from "@/features/shared/use-resource";
import { formatGiB, share } from "./format";
import { PeriodPicker, periodRange, useUsagePeriod } from "./period";
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

function UsageMetadata({ usage }: { usage: UsageDto }) {
  const previous = usage.previousPeriod;
  if (!previous) return null;
  return (
    <UsageSummary
      peak={usage.peakMinuteAverageBytesPerSecond ?? null}
      previous={{
        start: previous.previousStart,
        end: previous.previousEnd,
        bytes: previous.hasData
          ? (
              BigInt(previous.uploadBytes) + BigInt(previous.downloadBytes)
            ).toString()
          : null,
        incomplete: previous.incomplete,
      }}
      changePercent={previous.changePercent}
      currentIncomplete={usage.incomplete}
      currentInProgress={previous.currentPeriodInProgress}
    />
  );
}

function UsageTrend({ usage }: { usage: UsageDto }) {
  return (
    <>
      <UsageMetadata usage={usage} />
      <div className="actions mb-4">
        <DataQuality
          estimated={usage.estimated}
          incomplete={usage.incomplete}
        />
      </div>
      {usage.incomplete && (
        <p className="subtle mb-4">
          部分统计存在缺口，显示值可能低于实际用量。
        </p>
      )}
      <Trend
        kind={usage.grain === "minute" ? "line" : "bar"}
        points={usage.points.map((point) => ({
          label: (usage.grain === "minute" ? minuteLabel : dayLabel).format(
            point.bucketStart,
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
  const resource = useResource<UsageDto>(`/api/v1/me/usage?${period.query}`);
  const today = periodRange("today", period.month, period.now);
  const todayUsage = useResource<UsageDto>(
    `/api/v1/me/usage?start=${today.start}&end=${today.end}&grain=day`,
  );
  const refreshUsage = resource.refresh;
  const refreshToday = todayUsage.refresh;
  useEffect(() => {
    const interval = setInterval(() => {
      void refreshUsage();
      void refreshToday();
    }, 30_000);
    return () => clearInterval(interval);
  }, [refreshUsage, refreshToday]);
  const usage = resource.data;
  const quota = usage?.currentMonth;
  const totalToday = todayUsage.data?.points.length
    ? BigInt(todayUsage.data.uploadBytes) +
      BigInt(todayUsage.data.downloadBytes)
    : null;
  const remaining =
    quota?.limitBytes !== null && quota?.limitBytes !== undefined
      ? BigInt(quota.limitBytes) - BigInt(quota.usedBytes)
      : null;
  const hasCurrentUsage =
    !!quota &&
    (BigInt(quota.usedBytes) > 0n ||
      !!todayUsage.data?.points.length ||
      (period.period === "month" &&
        quota.period === period.month &&
        !!usage?.points.length));
  return (
    <>
      <div className="page-heading">
        <h1>我的概览</h1>
        <PeriodPicker value={period} />
      </div>
      <FormError message={resource.error || todayUsage.error} />
      {resource.error && <Button onClick={resource.refresh}>重新加载</Button>}
      {quota?.warning && (
        <p role="status" className="notice mb-6">
          {quota.blocked
            ? "已达到本月额度，代理接入暂停。"
            : `本月额度已使用 ${quota.warning}% 以上。`}
        </p>
      )}
      <div className="metric-row">
        <section className="panel">
          <h2>本月已用</h2>
          <strong className="metric-value">
            {quota && hasCurrentUsage ? formatGiB(quota.usedBytes) : "—"}
          </strong>
          {quota && (
            <span className="subtle">
              {quota.limitBytes === null
                ? "不限量"
                : quota.limitBytes === "0"
                  ? "额度为 0，暂无可用流量"
                  : hasCurrentUsage
                    ? `额度 ${formatGiB(quota.limitBytes)} · 已使用 ${share(quota.usedBytes, quota.limitBytes)}%`
                    : `额度 ${formatGiB(quota.limitBytes)} · 暂无统计记录`}
            </span>
          )}
        </section>
        <section className="panel">
          <h2>本月剩余</h2>
          <strong className="metric-value">
            {!quota
              ? "—"
              : remaining === null
                ? "不限量"
                : !hasCurrentUsage
                  ? "—"
                  : formatGiB(remaining > 0n ? remaining : 0n)}
          </strong>
          {quota && <span className="subtle">{quota.period} · 上海时区</span>}
        </section>
        <section className="panel">
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
        </section>
      </div>
      <section className="panel">
        <div className="panel-header">
          <h2>{period.period === "today" ? "今天用了多少" : "每天用了多少"}</h2>
          {!!usage?.points.length && (
            <span className="subtle text-xs">
              共{" "}
              {formatGiB(
                BigInt(usage.uploadBytes) + BigInt(usage.downloadBytes),
              )}
            </span>
          )}
        </div>
        {usage ? (
          <UsageTrend usage={usage} />
        ) : (
          <p className="empty-state">
            {resource.loading ? "正在加载用量…" : "用量暂时无法加载"}
          </p>
        )}
      </section>
      <section className="panel">
        <h2>用在哪些节点</h2>
        {usage ? (
          <GroupUsageTable groups={usage.groups} dimension="machine" />
        ) : (
          <p className="empty-state">尚未加载用量</p>
        )}
      </section>
    </>
  );
}

export function AdminUsageOverview() {
  const period = useUsagePeriod();
  const resource = useResource<UsageDto>(`/api/v1/admin/usage?${period.query}`);
  const machines = useResource<{ machines: MachineDto[] }>(
    "/api/v1/admin/machines",
  );
  const users = useResource<{ users: UserDto[] }>("/api/v1/admin/users");
  const refreshUsage = resource.refresh;
  const refreshMachines = machines.refresh;
  const refreshUsers = users.refresh;
  useEffect(() => {
    const interval = setInterval(() => {
      void refreshUsage();
      void refreshMachines();
      void refreshUsers();
    }, 30_000);
    return () => clearInterval(interval);
  }, [refreshUsage, refreshMachines, refreshUsers]);
  const usage = resource.data;
  return (
    <>
      <div className="page-heading">
        <h1>管理概览</h1>
        <PeriodPicker value={period} />
      </div>
      <FormError message={resource.error || machines.error || users.error} />
      {resource.error && <Button onClick={resource.refresh}>重新加载</Button>}
      <div className="metric-row">
        <section className="panel">
          <h2>在线机器</h2>
          <strong className="metric-value">
            {machines.data
              ? `${machines.data.machines.filter((machine) => machine.connection === "online" && !machine.uninstalled).length} / ${machines.data.machines.length}`
              : "—"}
          </strong>
        </section>
        <section className="panel">
          <h2>所选期间流量</h2>
          <strong className="metric-value">
            {usage?.points.length
              ? formatGiB(
                  BigInt(usage.uploadBytes) + BigInt(usage.downloadBytes),
                )
              : "—"}
          </strong>
          {!!usage?.points.length && (
            <span className="subtle">
              上传 {formatGiB(usage.uploadBytes)} · 下载{" "}
              {formatGiB(usage.downloadBytes)}
            </span>
          )}
        </section>
        <section className="panel">
          <h2>启用用户</h2>
          <strong className="metric-value">
            {users.data
              ? `${users.data.users.filter((user) => user.status === "active").length} / ${users.data.users.length}`
              : "—"}
          </strong>
        </section>
      </div>
      <section className="panel">
        <h2>上下行趋势</h2>
        {usage ? (
          <UsageTrend usage={usage} />
        ) : (
          <p className="empty-state">
            {resource.loading ? "正在加载用量…" : "用量暂时无法加载"}
          </p>
        )}
      </section>
      <section className="panel">
        <h2>节点用量</h2>
        {usage ? (
          <GroupUsageTable groups={usage.groups} dimension="machine" />
        ) : (
          <p className="empty-state">尚未加载用量</p>
        )}
      </section>
      <section className="panel">
        <h2>用户用量</h2>
        {usage ? (
          <GroupUsageTable groups={usage.groups} dimension="user" />
        ) : (
          <p className="empty-state">尚未加载用量</p>
        )}
      </section>
    </>
  );
}

export function UserNodeUsage() {
  const period = useUsagePeriod();
  const resource = useResource<UsageDto>(`/api/v1/admin/usage?${period.query}`);
  useEffect(() => {
    const interval = setInterval(resource.refresh, 30_000);
    return () => clearInterval(interval);
  }, [resource.refresh]);
  return (
    <section className="panel">
      <div className="panel-header flex-wrap">
        <h2>用户 × 节点用量</h2>
        <PeriodPicker value={period} />
      </div>
      <FormError message={resource.error} />
      {resource.error && (
        <Button onClick={resource.refresh}>重新加载用量</Button>
      )}
      {resource.data ? (
        <>
          <div className="actions">
            <DataQuality
              estimated={resource.data.estimated}
              incomplete={resource.data.incomplete}
            />
          </div>
          <UserMachineTable groups={resource.data.groups} />
          <UsageMetadata usage={resource.data} />
        </>
      ) : (
        <p className="empty-state">
          {resource.loading ? "正在加载用量…" : "用量暂时无法加载"}
        </p>
      )}
    </section>
  );
}

export function MachineUsage({ machineId }: { machineId: string }) {
  const period = useUsagePeriod();
  const resource = useResource<UsageDto>(
    `/api/v1/admin/usage?${period.query}&machineId=${encodeURIComponent(machineId)}`,
  );
  useEffect(() => {
    const interval = setInterval(resource.refresh, 30_000);
    return () => clearInterval(interval);
  }, [resource.refresh]);
  return (
    <section className="panel">
      <div className="panel-header flex-wrap">
        <h2>代理用量</h2>
        <PeriodPicker value={period} />
      </div>
      <FormError message={resource.error} />
      {resource.error && (
        <Button onClick={resource.refresh}>重新加载用量</Button>
      )}
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
          <details className="mt-4">
            <summary className="cursor-pointer py-2">用户分布</summary>
            <GroupUsageTable groups={resource.data.groups} dimension="user" />
          </details>
        </>
      ) : (
        <p className="empty-state">
          {resource.loading ? "正在加载用量…" : "用量暂时无法加载"}
        </p>
      )}
    </section>
  );
}
