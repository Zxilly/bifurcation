import type { MachineDto } from "@/contracts/machines";
import { formatBytes } from "@/features/usage/format";

const health = {
  unknown: "尚未上报",
  not_configured: "未配置",
  stopped: "已停止",
  healthy: "运行中",
  unhealthy: "运行异常",
};
const time = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "short",
  timeStyle: "medium",
  timeZone: "Asia/Shanghai",
});

export function MachineResources({ machine }: { machine: MachineDto }) {
  const resource = machine.resources;
  const networkInterface = resource.networkInterface
    ? `（${resource.networkInterface}）`
    : "";
  const fields = [
    ["管理连接", machine.streamConnected ? "已连接" : "连接中断"],
    [
      "操作系统",
      [machine.os, machine.arch].filter(Boolean).join(" / ") || "尚未上报",
    ],
    ["内嵌核心状态", health[machine.coreHealth]],
    [
      "CPU 使用率",
      resource.cpuUsagePercent === null
        ? "尚未上报"
        : `${resource.cpuUsagePercent.toLocaleString("zh-CN", { maximumFractionDigits: 1 })}%`,
    ],
    [
      "内存",
      resource.memoryUsedBytes === null
        ? "尚未上报"
        : `${formatBytes(resource.memoryUsedBytes)}${resource.memoryTotalBytes === null ? "" : ` / ${formatBytes(resource.memoryTotalBytes)}`}`,
    ],
    [
      "磁盘剩余",
      resource.diskFreeBytes === null
        ? "尚未上报"
        : formatBytes(resource.diskFreeBytes),
    ],
    ["代理连接数", resource.connections ?? "尚未上报"],
    [
      `网卡累计接收${networkInterface}`,
      resource.networkRxBytes === null
        ? "尚未上报"
        : formatBytes(resource.networkRxBytes),
    ],
    [
      `网卡累计发送${networkInterface}`,
      resource.networkTxBytes === null
        ? "尚未上报"
        : formatBytes(resource.networkTxBytes),
    ],
  ];
  return (
    <section className="panel">
      <div className="panel-header flex-wrap">
        <h2>运行信息</h2>
        <span className="subtle text-xs">
          {machine.lastSeenAt === null
            ? "尚未连接"
            : `最近上报 ${time.format(machine.lastSeenAt)}`}
        </span>
      </div>
      <dl className="grid gap-x-6 gap-y-5 sm:grid-cols-2 xl:grid-cols-4">
        {fields.map(([label, value]) => (
          <div key={label}>
            <dt className="subtle mb-2">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
