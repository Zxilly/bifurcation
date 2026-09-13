import "server-only";
import { CoreHealth, TaskKind } from "@bifurcation/rpc";
import { Role, UserStatus } from "@bifurcation/rpc/panel/types";
import { MachineConnection, RollbackState, TaskState } from "@bifurcation/rpc/panel/machines";
import { Reconciliation } from "@bifurcation/rpc/panel/configuration";
import { Grain } from "@bifurcation/rpc/panel/usage";
import { Authentication, BlockReason, ConfigurationState, Protocol } from "@bifurcation/rpc/panel/me";
import type { JsonObject } from "@bufbuild/protobuf";
import type { UserDto, ApiKeyDto, PasskeyDto } from "@/contracts/identity";
import type { MachineDto, MachineDetailDto, MachineTaskKind, TaskDto } from "@/contracts/machines";
import type { MachineUpgradesDto } from "@/contracts/upgrades";
import type { MachineConfigurationDto, ConfigurationPreviewDto } from "@/contracts/configuration";
import type { SubscriptionDto } from "@/contracts/subscription";
import type { UsageDto } from "@/contracts/usage";
const bigintOr = (value: string | null | undefined) => (value === null || value === undefined ? undefined : BigInt(value));
const timestamp = (value: number) => BigInt(value);
const timestampOr = (value: number | null | undefined) => (value === null || value === undefined ? undefined : BigInt(value));
const stringOr = (value: string | null | undefined) => value ?? undefined;

export const roles: Record<UserDto["role"], Role> = { admin: Role.ADMIN, user: Role.USER };
export const userStatuses: Record<UserDto["status"], UserStatus> = {
  pending: UserStatus.PENDING,
  active: UserStatus.ACTIVE,
  disabled: UserStatus.DISABLED,
};
export const authentications: Record<"session" | "apiKey", Authentication> = {
  session: Authentication.SESSION,
  apiKey: Authentication.API_KEY,
};
export const connections: Record<MachineDto["connection"], MachineConnection> = {
  waiting: MachineConnection.WAITING,
  online: MachineConnection.ONLINE,
  offline: MachineConnection.OFFLINE,
};
export const taskKinds: Record<MachineTaskKind, TaskKind> = {
  inspect: TaskKind.INSPECT,
  apply_config: TaskKind.APPLY_CONFIG,
  upgrade_daemon: TaskKind.UPGRADE_DAEMON,
  uninstall: TaskKind.UNINSTALL,
};
export const taskStates: Record<TaskDto["state"], TaskState> = {
  queued: TaskState.QUEUED,
  accepted: TaskState.ACCEPTED,
  running: TaskState.RUNNING,
  succeeded: TaskState.SUCCEEDED,
  failed: TaskState.FAILED,
  canceled: TaskState.CANCELED,
  superseded: TaskState.SUPERSEDED,
};
export const rollbackStates: Record<TaskDto["rollback"], RollbackState> = {
  unspecified: RollbackState.UNSPECIFIED,
  not_needed: RollbackState.NOT_NEEDED,
  succeeded: RollbackState.SUCCEEDED,
  failed: RollbackState.FAILED,
};
export const coreHealths: Record<MachineDto["coreHealth"], CoreHealth> = {
  unknown: CoreHealth.UNSPECIFIED,
  not_configured: CoreHealth.NOT_CONFIGURED,
  stopped: CoreHealth.STOPPED,
  healthy: CoreHealth.HEALTHY,
  unhealthy: CoreHealth.UNHEALTHY,
};
export const reconciliations: Record<MachineConfigurationDto["reconciliation"], Reconciliation> = {
  not_configured: Reconciliation.NOT_CONFIGURED,
  pending: Reconciliation.PENDING,
  applied: Reconciliation.APPLIED,
  failed: Reconciliation.FAILED,
};
export const grains: Record<"minute" | "day" | "month", Grain> = {
  minute: Grain.MINUTE,
  day: Grain.DAY,
  month: Grain.MONTH,
};
export const grainNames: Record<Grain, "minute" | "day" | "month" | undefined> = {
  [Grain.UNSPECIFIED]: undefined,
  [Grain.MINUTE]: "minute",
  [Grain.DAY]: "day",
  [Grain.MONTH]: "month",
};
export const protocols: Record<"trojan" | "hysteria2", Protocol> = {
  trojan: Protocol.TROJAN,
  hysteria2: Protocol.HYSTERIA2,
};
export const configurationStates: Record<"pending" | "applied", ConfigurationState> = {
  pending: ConfigurationState.PENDING,
  applied: ConfigurationState.APPLIED,
};
export const blockReasons: Record<"disabled" | "quota", BlockReason> = {
  disabled: BlockReason.DISABLED,
  quota: BlockReason.QUOTA,
};

export function toProtoUser(user: UserDto) {
  return {
    id: user.id,
    username: user.username,
    role: roles[user.role],
    status: userStatuses[user.status],
    monthlyLimitBytes: stringOr(user.monthlyLimitBytes),
    version: user.version,
    createdAt: timestamp(user.createdAt),
  };
}

export function toProtoApiKey(apiKey: ApiKeyDto) {
  return {
    id: apiKey.id,
    name: apiKey.name,
    prefix: apiKey.prefix,
    createdAt: timestamp(apiKey.createdAt),
    lastUsedAt: timestampOr(apiKey.lastUsedAt),
    revokedAt: timestampOr(apiKey.revokedAt),
  };
}

export function toProtoPasskey(passkey: PasskeyDto) {
  return {
    id: passkey.id,
    name: passkey.name,
    createdAt: timestamp(passkey.createdAt),
    backedUp: passkey.backedUp,
  };
}

export function toProtoTask(task: TaskDto) {
  return {
    id: task.id,
    machineId: task.machineId,
    kind: taskKinds[task.kind],
    state: taskStates[task.state],
    phase: stringOr(task.phase),
    progressPercent: task.progressPercent ?? undefined,
    message: stringOr(task.message),
    errorCode: stringOr(task.errorCode),
    rollback: rollbackStates[task.rollback],
    diagnostic: (task.diagnostic ?? undefined) as JsonObject | undefined,
    createdAt: timestamp(task.createdAt),
    updatedAt: timestamp(task.updatedAt),
  };
}

function toProtoResources(resources: MachineDto["resources"]) {
  return {
    cpuUsagePercent: resources.cpuUsagePercent ?? undefined,
    memoryUsedBytes: bigintOr(resources.memoryUsedBytes),
    memoryTotalBytes: bigintOr(resources.memoryTotalBytes),
    diskFreeBytes: bigintOr(resources.diskFreeBytes),
    connections: bigintOr(resources.connections),
    networkRxBytes: bigintOr(resources.networkRxBytes),
    networkTxBytes: bigintOr(resources.networkTxBytes),
    networkInterface: stringOr(resources.networkInterface),
  };
}

function machineFields(machine: MachineDto) {
  return {
    id: machine.id,
    name: machine.name,
    address: machine.address,
    region: machine.region,
    connection: connections[machine.connection],
    streamConnected: machine.streamConnected,
    uninstalled: machine.uninstalled,
    lastSeenAt: timestampOr(machine.lastSeenAt),
    daemonVersion: stringOr(machine.daemonVersion),
    coreVersion: stringOr(machine.coreVersion),
    coreHealth: coreHealths[machine.coreHealth],
    installationId: stringOr(machine.installationId),
    createdAt: timestamp(machine.createdAt),
    version: machine.version,
    activeTaskCount: machine.activeTaskCount,
    os: stringOr(machine.os),
    arch: stringOr(machine.arch),
    capabilities: machine.capabilities.map((kind) => taskKinds[kind]),
    appliedRevisionId: stringOr(machine.appliedRevisionId),
    appliedPolicyRevision: BigInt(machine.appliedPolicyRevision),
    appliedConfigSha256: stringOr(machine.appliedConfigSha256),
    resources: toProtoResources(machine.resources),
  };
}

export function toProtoMachine(machine: MachineDto) {
  return machineFields(machine);
}

export function toProtoMachineDetail(machine: MachineDetailDto) {
  return {
    ...machineFields(machine),
    token: machine.token,
    installCommand: machine.installCommand,
    tasks: machine.tasks.map(toProtoTask),
    issue: stringOr(machine.issue),
  };
}

export function toProtoMachineUpgrades(upgrades: MachineUpgradesDto) {
  return {
    machineId: upgrades.machineId,
    bundledCoreVersion: stringOr(upgrades.bundledCoreVersion),
    availableBundledCoreVersion: stringOr(upgrades.availableBundledCoreVersion),
    daemon: {
      currentVersion: stringOr(upgrades.daemon.currentVersion),
      availableVersion: stringOr(upgrades.daemon.availableVersion),
      sha256: stringOr(upgrades.daemon.sha256),
      sizeBytes: bigintOr(upgrades.daemon.sizeBytes),
      executable: upgrades.daemon.executable,
      disabledReason: stringOr(upgrades.daemon.disabledReason),
      sameVersion: upgrades.daemon.sameVersion,
    },
    activeTask: upgrades.activeTask ? toProtoTask(upgrades.activeTask) : undefined,
  };
}

export function toProtoConfiguration(configuration: MachineConfigurationDto) {
  return {
    settings: configuration.settings === null ? undefined : settingsToProto(configuration.settings),
    version: configuration.version,
    desiredRevisionId: stringOr(configuration.desiredRevisionId),
    desiredPolicyRevision: bigintOr(configuration.desiredPolicyRevision),
    appliedRevisionId: stringOr(configuration.appliedRevisionId),
    appliedPolicyRevision: bigintOr(configuration.appliedPolicyRevision),
    reconciliation: reconciliations[configuration.reconciliation],
    latestTask: configuration.latestTask ? toProtoTask(configuration.latestTask) : undefined,
    bundledCoreVersion: stringOr(configuration.bundledCoreVersion),
  };
}

function settingsToProto(settings: NonNullable<MachineConfigurationDto["settings"]>) {
  const tls = settings.tls;
  return {
    listen: settings.listen,
    trojanPort: settings.trojanPort,
    hysteria2Port: settings.hysteria2Port,
    tls: {
      serverName: tls.serverName,
      mode:
        tls.mode === "pem"
          ? { case: "pem" as const, value: { certificatePem: tls.certificatePem, privateKeyPem: tls.privateKeyPem } }
          : tls.mode === "path"
            ? { case: "path" as const, value: { certificatePath: tls.certificatePath, privateKeyPath: tls.privateKeyPath } }
            : { case: "acme" as const, value: { email: tls.email } },
    },
    baseJson: settings.baseJson as JsonObject,
  };
}

export function toProtoPreview(preview: ConfigurationPreviewDto) {
  return {
    previewId: preview.previewId,
    expectedVersion: preview.expectedVersion,
    policyRevision: BigInt(preview.policyRevision),
    digest: preview.digest,
    finalJson: preview.finalJson,
    expiresAt: timestamp(preview.expiresAt),
  };
}

export function toProtoSubscription(subscription: SubscriptionDto) {
  return {
    url: subscription.url,
    generation: subscription.generation,
    credentialGeneration: subscription.credentialGeneration,
    configFormatVersion: subscription.configFormatVersion,
    blocked: subscription.blocked,
    blockReason: subscription.blockReason === null ? undefined : blockReasons[subscription.blockReason],
    nodes: subscription.nodes.map((node) => ({
      machineId: node.machineId,
      name: node.name,
      address: node.address,
      protocols: node.protocols.map((protocol) => protocols[protocol]),
      configurationState: configurationStates[node.configurationState],
      available: node.available,
    })),
    configJson: subscription.configJson,
  };
}

export function toProtoUsage(usage: UsageDto) {
  return {
    start: timestamp(usage.start),
    end: timestamp(usage.end),
    grain: grains[usage.grain],
    uploadBytes: BigInt(usage.uploadBytes),
    downloadBytes: BigInt(usage.downloadBytes),
    estimated: usage.estimated,
    incomplete: usage.incomplete,
    points: usage.points.map((point) => ({
      bucketStart: timestamp(point.bucketStart),
      uploadBytes: BigInt(point.uploadBytes),
      downloadBytes: BigInt(point.downloadBytes),
      estimated: point.estimated,
      incomplete: point.incomplete,
    })),
    groups: usage.groups.map((group) => ({
      userId: group.userId,
      username: group.username,
      machineId: group.machineId,
      machineName: group.machineName,
      uploadBytes: BigInt(group.uploadBytes),
      downloadBytes: BigInt(group.downloadBytes),
      estimated: group.estimated,
      incomplete: group.incomplete,
    })),
    currentMonth:
      usage.currentMonth === null
        ? undefined
        : {
            period: usage.currentMonth.period,
            usedBytes: BigInt(usage.currentMonth.usedBytes),
            limitBytes: bigintOr(usage.currentMonth.limitBytes),
            blocked: usage.currentMonth.blocked,
            warning: stringOr(usage.currentMonth.warning),
          },
    peakMinuteAverageBytesPerSecond: usage.peakMinuteAverageBytesPerSecond ?? undefined,
    previousPeriod: {
      previousStart: timestamp(usage.previousPeriod.previousStart),
      previousEnd: timestamp(usage.previousPeriod.previousEnd),
      uploadBytes: BigInt(usage.previousPeriod.uploadBytes),
      downloadBytes: BigInt(usage.previousPeriod.downloadBytes),
      hasData: usage.previousPeriod.hasData,
      incomplete: usage.previousPeriod.incomplete,
      currentPeriodInProgress: usage.previousPeriod.currentPeriodInProgress,
      changePercent: usage.previousPeriod.changePercent ?? undefined,
    },
  };
}
