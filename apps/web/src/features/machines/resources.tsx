import { LayerCard, Meter } from "@cloudflare/kumo";
import type { MachineDetail } from "@bifurcation/rpc/panel/machines";
import { formatBytes } from "@/features/usage/format";
import { percent, reportedAt } from "./status";

export function MachineResources({ machine }: { machine: MachineDetail }) {
  const resources = machine.resources;
  const cpu = resources?.cpuUsagePercent;
  const used = resources?.memoryUsedBytes;
  const total = resources?.memoryTotalBytes;
  const memory =
    used == null
      ? "未上报"
      : `${formatBytes(used)}${total == null ? "" : ` / ${formatBytes(total)}`}`;
  const memoryPercent =
    used != null && total != null && total > 0n
      ? Math.min(100, Math.max(0, (Number(used) / Number(total)) * 100))
      : null;
  return (
    <LayerCard
      render={<section aria-labelledby="machine-resources-title" />}
      className="machine-resources"
    >
      <div className="machine-section-heading">
        <h2 id="machine-resources-title">运行信息</h2>
        <span className="subtle text-xs">
          {machine.lastSeenAt == null
            ? "等待节点上报"
            : `最近上报 ${reportedAt(machine.lastSeenAt)}`}
        </span>
      </div>
      {!machine.streamConnected && (
        <p className="text-kumo-warning mb-4">
          管理连接已中断，以下为最近上报值。
        </p>
      )}
      <div className="machine-resource-grid">
        <div>
          {cpu == null ? (
            <dl>
              <dt className="subtle">CPU 使用率</dt>
              <dd className="mt-2">未上报</dd>
            </dl>
          ) : (
            <Meter
              label="CPU 使用率"
              value={Math.min(100, Math.max(0, cpu))}
              customValue={percent(cpu)}
            />
          )}
        </div>
        <div>
          {memoryPercent == null ? (
            <dl>
              <dt className="subtle">内存</dt>
              <dd className="mt-2">{memory}</dd>
            </dl>
          ) : (
            <Meter label="内存" value={memoryPercent} customValue={memory} />
          )}
        </div>
        <dl>
          <dt className="subtle">磁盘剩余</dt>
          <dd className="mt-2 font-medium">
            {resources?.diskFreeBytes == null
              ? "未上报"
              : formatBytes(resources.diskFreeBytes)}
          </dd>
        </dl>
        <dl>
          <dt className="subtle">代理连接数</dt>
          <dd className="mt-2 font-medium">
            {resources?.connections?.toLocaleString("zh-CN") ?? "未上报"}
          </dd>
        </dl>
      </div>
      <div className="machine-network-summary">
        <span className="subtle">
          网卡累计
          {resources?.networkInterface
            ? ` · ${resources.networkInterface}`
            : ""}
        </span>
        <span>
          接收{" "}
          {resources?.networkRxBytes == null
            ? "未上报"
            : formatBytes(resources.networkRxBytes)}
        </span>
        <span>
          发送{" "}
          {resources?.networkTxBytes == null
            ? "未上报"
            : formatBytes(resources.networkTxBytes)}
        </span>
        <span className="subtle text-xs">主机流量，不计入代理用量</span>
      </div>
    </LayerCard>
  );
}
