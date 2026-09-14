import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { create, fromBinary, fromJsonString } from "@bufbuild/protobuf";
import { MachineStatusSchema, TaskKind, TaskSpecSchema } from "@bifurcation/rpc";
import { z } from "zod";
import type { MachineUpgradesDto, UpgradeCandidateDto, UpgradeResultDto } from "@/contracts/upgrades";
import { getDatabase, type DatabaseHandle } from "@/server/db";
import { machines, tasks } from "@/server/db/schema-machines";
import { MachineStore } from "@/server/modules/machines/store";
import { AppError } from "@/server/http/errors";
import { taskHub } from "@/server/rpc/task-hub";
import { maintenanceInfo } from "@/contracts/maintenance";
import { getDaemonRelease, type DaemonRelease } from "./artifacts";

const upgradeInput = z.object({ expectedSha256: z.string().regex(/^[a-f0-9]{64}$/), requestKey: z.uuid() }).strict();
type MachineRow = typeof machines.$inferSelect;
export class ReleaseStore {
  constructor(private readonly handle: DatabaseHandle = getDatabase()) {}

  private active(machineId: string) {
    return this.handle.db.select().from(tasks).where(and(eq(tasks.machineId, machineId), inArray(tasks.kind, [TaskKind.UPGRADE_DAEMON, TaskKind.UNINSTALL]), inArray(tasks.state, ["queued", "accepted", "running"])))
      .orderBy(sql`CASE WHEN ${tasks.state} = 'running' THEN 0 WHEN ${tasks.state} = 'accepted' THEN 1 ELSE 2 END`, asc(tasks.createdAt)).get();
  }
  private candidate(machine: MachineRow, active: boolean, release: DaemonRelease | null, unavailableReason: string | null = null): UpgradeCandidateDto {
    const currentVersion = machine.daemonVersion;
    const artifact = release?.artifact;
    let disabledReason = unavailableReason;
    const status = machine.statusJson ? fromJsonString(MachineStatusSchema, machine.statusJson) : undefined;
    const maintenance = maintenanceInfo(status?.maintenanceStatus ?? 0, (JSON.parse(machine.supportedTasks) as number[]).includes(TaskKind.UPGRADE_DAEMON));
    if (new MachineStore(this.handle).isUninstalled(machine.id, machine.bindingEpoch)) disabledReason = "节点已卸载；保留记录用于结果确认，之后可单独移除记录";
    else if (!machine.installationId) disabledReason = "机器尚未接入";
    else if (machine.os !== "linux") disabledReason = "升级仅支持 Linux 节点";
    else if (!maintenance.available) disabledReason = maintenance.description;
    else if (active) disabledReason = "已有升级任务正在进行";
    else if (artifact?.version === currentVersion) disabledReason = "daemon 已是当前可用版本";
    return { currentVersion, availableVersion: artifact?.version ?? null, sha256: artifact?.sha256 ?? null, sizeBytes: artifact?.sizeBytes.toString() ?? null, executable: !!artifact && disabledReason === null, disabledReason, sameVersion: !!artifact && artifact.version === currentVersion };
  }
  get(machineId: string): MachineUpgradesDto {
    const store = new MachineStore(this.handle);
    const machine = store.get(machineId);
    const active = this.active(machineId);
    let release: DaemonRelease | null = null;
    let unavailableReason: string | null = null;
    try { release = getDaemonRelease(machine.arch); }
    catch (error) { if (!(error instanceof AppError)) throw error; unavailableReason = error.message; }
    const status = machine.statusJson ? fromJsonString(MachineStatusSchema, machine.statusJson) : undefined;
    return { machineId, bundledCoreVersion: status?.coreVersion || null, availableBundledCoreVersion: release?.bundledCoreVersion ?? null, daemon: this.candidate(machine, !!active, release, unavailableReason), activeTask: active ? store.getTask(machineId, active.id) : null };
  }
  enqueue(machineId: string, input: unknown): UpgradeResultDto {
    const parsed = upgradeInput.parse(input);
    const result = this.handle.db.transaction((tx) => {
      const store = new MachineStore(this.handle);
      const machine = store.get(machineId);
      const existing = tx.select().from(tasks).where(and(eq(tasks.machineId, machineId), eq(tasks.requestKey, parsed.requestKey))).get();
      if (existing) {
        const spec = fromBinary(TaskSpecSchema, existing.payload);
        if (spec.operation.case !== "upgradeDaemon" || spec.operation.value.artifact?.sha256 !== parsed.expectedSha256) throw new AppError("REQUEST_CONFLICT", "请求标识已用于另一操作", 409);
        return { task: store.getTask(machineId, existing.id) };
      }
      const release = getDaemonRelease(machine.arch);
      const artifact = release.artifact;
      if (artifact.sha256 !== parsed.expectedSha256) throw new AppError("ARTIFACT_CHANGED", "可用制品已变化，请刷新并重新确认", 409);
      const candidate = this.candidate(machine, !!this.active(machineId), release);
      if (!candidate.executable) throw new AppError("UPGRADE_UNAVAILABLE", candidate.disabledReason ?? "暂时无法升级", 409);
      const spec = create(TaskSpecSchema, { operation: { case: "upgradeDaemon", value: { artifact } } });
      return { task: store.enqueueTask(machineId, spec, parsed.requestKey) };
    });
    taskHub.wake(machineId);
    return result;
  }
  uninstall(machineId: string, input: unknown): UpgradeResultDto {
    const parsed = z.object({ requestKey: z.uuid() }).strict().parse(input);
    const machine = new MachineStore(this.handle).get(machineId);
    const existing = this.handle.db.select().from(tasks).where(and(eq(tasks.machineId, machineId), eq(tasks.requestKey, parsed.requestKey))).get();
    if (!existing && new MachineStore(this.handle).isUninstalled(machineId, machine.bindingEpoch)) throw new AppError("MACHINE_UNINSTALLED", "节点已经完成卸载，可单独移除记录", 409);
    const spec = create(TaskSpecSchema, { operation: { case: "uninstall", value: {} } });
    const task = new MachineStore(this.handle).enqueueTask(machineId, spec, parsed.requestKey);
    // The machine and its token remain valid so the independent helper can retry
    // its final report if the ACK is lost. Removing the record is a separate action.
    taskHub.wake(machineId);
    return { task };
  }
}
