export type MachineConnection = "waiting" | "online" | "offline";
export type TaskStatus = "queued" | "accepted" | "running" | "succeeded" | "failed" | "canceled" | "superseded";
export type MachineTaskKind = "inspect" | "apply_config" | "upgrade_daemon" | "uninstall";

export interface MachineDto {
  id: string;
  name: string;
  address: string;
  region: string;
  connection: MachineConnection;
  streamConnected: boolean;
  uninstalled: boolean;
  lastSeenAt: number | null;
  daemonVersion: string | null;
  coreVersion: string | null;
  coreHealth: "unknown" | "not_configured" | "stopped" | "healthy" | "unhealthy";
  installationId: string | null;
  createdAt: number;
  version: number;
  activeTaskCount: number;
  os: string | null;
  arch: string | null;
  capabilities: MachineTaskKind[];
  appliedRevisionId: string | null;
  appliedPolicyRevision: string;
  appliedConfigSha256: string | null;
  resources: {
    cpuUsagePercent: number | null;
    memoryUsedBytes: string | null;
    memoryTotalBytes: string | null;
    diskFreeBytes: string | null;
    connections: string | null;
    networkRxBytes: string | null;
    networkTxBytes: string | null;
    networkInterface: string | null;
  };
}

export interface MachineDetailDto extends MachineDto {
  token: string;
  installCommand: string;
  tasks: TaskDto[];
  issue: string | null;
}

export interface TaskDto {
  id: string;
  machineId: string;
  kind: MachineTaskKind;
  state: TaskStatus;
  phase: string | null;
  progressPercent: number | null;
  message: string | null;
  errorCode: string | null;
  rollback: "unspecified" | "not_needed" | "succeeded" | "failed";
  diagnostic: unknown | null;
  createdAt: number;
  updatedAt: number;
}

