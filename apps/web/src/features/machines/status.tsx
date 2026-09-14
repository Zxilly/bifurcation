import { Badge } from "@cloudflare/kumo";
import { CoreHealth } from "@bifurcation/rpc";
import { MachineConnection } from "@bifurcation/rpc/panel/machines";

export const connectionNames: Record<number, string> = {
  [MachineConnection.WAITING]: "待接入",
  [MachineConnection.ONLINE]: "在线",
  [MachineConnection.OFFLINE]: "失联",
};

export const coreHealthNames: Record<number, string> = {
  [CoreHealth.UNSPECIFIED]: "未上报",
  [CoreHealth.NOT_CONFIGURED]: "未配置",
  [CoreHealth.STOPPED]: "已停止",
  [CoreHealth.HEALTHY]: "运行中",
  [CoreHealth.UNHEALTHY]: "运行异常",
};

export function ConnectionBadge({
  connection,
  uninstalled,
}: {
  connection: MachineConnection;
  uninstalled: boolean;
}) {
  return (
    <Badge
      variant={
        uninstalled
          ? "secondary"
          : connection === MachineConnection.ONLINE
            ? "success"
            : connection === MachineConnection.OFFLINE
              ? "error"
              : "secondary"
      }
    >
      {uninstalled ? "已卸载" : (connectionNames[connection] ?? "未知状态")}
    </Badge>
  );
}

export function percent(value: number | null | undefined) {
  return value == null
    ? "未上报"
    : `${value.toLocaleString("zh-CN", { maximumFractionDigits: 1 })}%`;
}

const reportTime = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "short",
  timeStyle: "medium",
  timeZone: "Asia/Shanghai",
});

export function reportedAt(value: bigint) {
  return reportTime.format(Number(value));
}
