import { MaintenanceStatus } from "@bifurcation/rpc";

const reasons: Partial<
  Record<MaintenanceStatus, { label: string; description: string }>
> = {
  [MaintenanceStatus.CONTAINER]: {
    label: "容器维护",
    description:
      "该节点由容器管理，请更新镜像并重建容器。面板无法在此安装方式下升级或卸载节点程序。",
  },
  [MaintenanceStatus.UNSUPPORTED_OS]: {
    label: "系统不支持",
    description:
      "在线维护仅支持 Linux systemd 节点，请通过当前系统的部署工具更新程序。",
  },
  [MaintenanceStatus.NONSTANDARD_BINARY]: {
    label: "手动维护",
    description:
      "daemon 不在标准安装路径。请在节点端手动更新，或使用安装命令部署为 systemd 服务。",
  },
  [MaintenanceStatus.INVALID_STATE_DIRECTORY]: {
    label: "安装需要修复",
    description:
      "节点状态目录不符合在线维护要求，请将其配置为独立的绝对路径后重启 daemon。",
  },
  [MaintenanceStatus.INVALID_PATHS]: {
    label: "安装需要修复",
    description:
      "程序、配置或状态目录无法安全访问，或使用了符号链接。请检查节点文件和权限后重启 daemon。",
  },
  [MaintenanceStatus.UNMANAGED_SERVICE]: {
    label: "手动维护",
    description:
      "未找到安装器管理的 systemd 服务。请在节点端手动更新，或使用安装命令完成标准安装。",
  },
};

// Task capabilities remain the authority. A maintenance report explains a
// limitation, and can never grant a task the daemon has not advertised.
export function maintenanceInfo(status: MaintenanceStatus, supported: boolean) {
  const reason = reasons[status];
  if (reason) return { ...reason, available: false };
  if (
    supported &&
    (status === MaintenanceStatus.AVAILABLE ||
      status === MaintenanceStatus.UNSPECIFIED)
  ) {
    return {
      label: "面板在线维护",
      description:
        "通过面板升级 daemon 与内嵌 sing-box，执行时代理连接会中断。",
      available: true,
    };
  }
  return {
    label: "维护方式待确认",
    description:
      "当前 daemon 未上报维护原因。请检查节点安装方式；旧版 daemon 需在节点端更新后才能报告具体原因。",
    available: false,
  };
}
