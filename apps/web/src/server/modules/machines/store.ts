import "server-only";
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { create, toBinary, toJsonString, fromJsonString, fromBinary } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  CoreHealth, MachineStatusSchema, ReportTaskRequestSchema, RollbackState, TaskKind, TaskSpecSchema, TaskState,
  type Installation, type MachineStatus, type ReportTaskRequest, type TaskSpec,
} from "@bifurcation/rpc";
import type { MachineDto, MachineDetailDto, MachineTaskKind, TaskDto } from "@/contracts/machines";
import { getDatabase, type DatabaseHandle } from "@/server/db";
import { machines, tasks } from "@/server/db/schema-machines";
import { decryptSecret, encryptSecret, newId, newToken, sha256, tokenHash } from "@/server/crypto";
import { AppError } from "@/server/http/errors";
import { getEnvironment } from "@/server/runtime/env";
import { taskHub } from "@/server/rpc/task-hub";

type MachineRow = typeof machines.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;
const pendingStates = ["queued", "accepted", "running"] as const;
const kindNames: Record<number, MachineTaskKind> = {
  [TaskKind.INSPECT]: "inspect", [TaskKind.APPLY_CONFIG]: "apply_config",
  [TaskKind.UPGRADE_DAEMON]: "upgrade_daemon", [TaskKind.UNINSTALL]: "uninstall",
};

export function integerSequence(value: bigint, name: string, allowZero = false): number {
  if (value < (allowZero ? 0n : 1n) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ConnectError(`${name} is out of range`, Code.InvalidArgument);
  }
  return Number(value);
}

function taskDto(row: TaskRow): TaskDto {
  return {
    id: row.id, machineId: row.machineId, kind: kindNames[row.kind], state: row.state,
    phase: row.phase, progressPercent: row.progressPercent, message: row.message,
    errorCode: row.errorCode, diagnostic: row.diagnosticJson ? JSON.parse(row.diagnosticJson) : null,
    rollback: row.rollback === RollbackState.NOT_NEEDED ? "not_needed" : row.rollback === RollbackState.SUCCEEDED ? "succeeded" : row.rollback === RollbackState.FAILED ? "failed" : "unspecified",
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

export class MachineStore {
  constructor(private readonly handle: DatabaseHandle = getDatabase()) {}
  get database() { return this.handle; }

  get(id: string): MachineRow {
    const row = this.handle.db.select().from(machines).where(and(eq(machines.id, id), isNull(machines.removedAt))).get();
    if (!row) throw new AppError("MACHINE_NOT_FOUND", "机器不存在", 404);
    return row;
  }

  authenticate(header: string | null): MachineRow {
    const match = /^Bearer (bm_[A-Za-z0-9_-]{43})$/.exec(header ?? "");
    if (!match) throw new ConnectError("invalid machine token", Code.Unauthenticated);
    const row = this.handle.db.select().from(machines).where(and(eq(machines.tokenHash, tokenHash(match[1])), isNull(machines.removedAt))).get();
    if (!row) throw new ConnectError("invalid machine token", Code.Unauthenticated);
    return row;
  }

  assertInstallation(row: MachineRow, identity: Installation | undefined, allowInitial = false) {
    if (!identity || !/^[A-Za-z0-9_-]{16,128}$/.test(identity.installationId)) {
      throw new ConnectError("invalid installation identity", Code.InvalidArgument);
    }
    const epoch = integerSequence(identity.bindingEpoch, "binding epoch", allowInitial);
    if (row.installationId && row.installationId !== identity.installationId) {
      throw new ConnectError("INSTANCE_CONFLICT", Code.FailedPrecondition);
    }
    if (row.installationId && epoch !== row.bindingEpoch && !(allowInitial && epoch === 0)) {
      throw new ConnectError("STALE_BINDING", Code.FailedPrecondition);
    }
    if (!allowInitial && !row.installationId) throw new ConnectError("machine is not enrolled", Code.FailedPrecondition);
    if (!row.installationId && epoch !== 0) throw new ConnectError("STALE_BINDING", Code.FailedPrecondition);
  }

  bind(id: string, identity: Installation | undefined, info: { daemonVersion: string; os: string; arch: string; supportedTasks: TaskKind[] }) {
    return this.handle.db.transaction((tx) => {
      const current = tx.select().from(machines).where(and(eq(machines.id, id), isNull(machines.removedAt))).get();
      if (!current) throw new ConnectError("invalid machine", Code.Unauthenticated);
      this.assertInstallation(current, identity, true);
      if (this.isUninstalled(id, current.bindingEpoch)) throw new ConnectError("MACHINE_UNINSTALLED", Code.FailedPrecondition);
      const bindingEpoch = current.bindingEpoch || 1;
      const updated = tx.update(machines).set({
        installationId: identity!.installationId, bindingEpoch,
        sessionEpoch: current.sessionEpoch + 1, statusSequence: 0,
        daemonVersion: info.daemonVersion, os: info.os, arch: info.arch,
        supportedTasks: JSON.stringify(info.supportedTasks), lastSeenAt: Date.now(),
      }).where(eq(machines.id, id)).returning().get();
      return updated;
    });
  }

  create(input: { name: string; address: string; region: string }): MachineDetailDto {
    const token = newToken("bm_");
    const row = this.handle.db.insert(machines).values({
      id: newId(), ...input, tokenHash: tokenHash(token), tokenCiphertext: encryptSecret(token), createdAt: Date.now(),
    }).returning().get();
    return this.detail(row.id);
  }

  isUninstalled(id: string, bindingEpoch = this.get(id).bindingEpoch): boolean {
    return !!this.handle.db.select({ id: tasks.id }).from(tasks).where(and(
      eq(tasks.machineId, id), eq(tasks.bindingEpoch, bindingEpoch),
      eq(tasks.kind, TaskKind.UNINSTALL), eq(tasks.state, "succeeded"),
    )).get();
  }

  update(id: string, input: { expectedVersion: number; name?: string; address?: string; region?: string }): MachineDetailDto {
    const row = this.get(id);
    if (row.version !== input.expectedVersion) throw new AppError("VERSION_CONFLICT", "机器信息已变化，请刷新后重试", 409);
    this.handle.db.update(machines).set({
      name: input.name ?? row.name, address: input.address ?? row.address, region: input.region ?? row.region,
      version: row.version + 1,
    }).where(and(eq(machines.id, id), eq(machines.version, input.expectedVersion))).run();
    return this.detail(id);
  }

  rebind(id: string, expectedVersion: number): MachineDetailDto {
    const row = this.get(id);
    if (row.version !== expectedVersion) throw new AppError("VERSION_CONFLICT", "机器信息已变化，请刷新后重试", 409);
    const token = newToken("bm_");
    this.handle.db.transaction((tx) => {
      if (tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.machineId, id), inArray(tasks.state, ["accepted", "running"]))).get()) {
        throw new AppError("TASK_ACTIVE", "仍有未确认任务，请先核对执行结果", 409);
      }
      tx.update(machines).set({
        installationId: null, bindingEpoch: row.bindingEpoch + 1, sessionEpoch: row.sessionEpoch + 1,
        tokenHash: tokenHash(token), tokenCiphertext: encryptSecret(token), tokenGeneration: row.tokenGeneration + 1,
        statusSequence: 0, statusJson: null, daemonVersion: null, os: null, arch: null,
        supportedTasks: "[]", lastSeenAt: null, version: row.version + 1,
      }).where(eq(machines.id, id)).run();
      tx.update(tasks).set({ state: "canceled", updatedAt: Date.now() }).where(and(eq(tasks.machineId, id), eq(tasks.state, "queued"))).run();
    });
    return this.detail(id);
  }

  private dto(row: MachineRow): MachineDto {
    const status = row.statusJson ? fromJsonString(MachineStatusSchema, row.statusJson) : undefined;
    const uninstalled = this.isUninstalled(row.id, row.bindingEpoch);
    const health = {
      [CoreHealth.UNSPECIFIED]: "unknown", [CoreHealth.NOT_CONFIGURED]: "not_configured",
      [CoreHealth.STOPPED]: "stopped", [CoreHealth.HEALTHY]: "healthy", [CoreHealth.UNHEALTHY]: "unhealthy",
    } as const;
    return {
      id: row.id, name: row.name, address: row.address, region: row.region,
      connection: uninstalled ? "offline" : !row.installationId ? "waiting" : row.lastSeenAt && Date.now() - row.lastSeenAt < 60_000 ? "online" : "offline",
      uninstalled,
      streamConnected: !uninstalled && taskHub.connected(row.id),
      lastSeenAt: row.lastSeenAt, daemonVersion: row.daemonVersion,
      coreVersion: status?.coreVersion || null, coreHealth: health[status?.coreHealth ?? CoreHealth.UNSPECIFIED] ?? "unknown",
      installationId: row.installationId, createdAt: row.createdAt, version: row.version,
      os: row.os, arch: row.arch,
      capabilities: (JSON.parse(row.supportedTasks) as number[]).map((kind) => kindNames[kind]).filter(Boolean),
      appliedRevisionId: status?.appliedRevisionId || null,
      appliedPolicyRevision: String(status?.appliedPolicyRevision ?? 0n),
      appliedConfigSha256: status?.appliedConfigSha256 || null,
      resources: {
        cpuUsagePercent: status?.cpuUsagePercent ?? null,
        memoryUsedBytes: status?.memoryUsedBytes?.toString() ?? null,
        memoryTotalBytes: status?.memoryTotalBytes?.toString() ?? null,
        diskFreeBytes: status?.diskFreeBytes?.toString() ?? null,
        connections: status?.connections?.toString() ?? null,
        networkRxBytes: status?.networkRxBytes?.toString() ?? null,
        networkTxBytes: status?.networkTxBytes?.toString() ?? null,
        networkInterface: status?.networkInterface || null,
      },
      activeTaskCount: this.handle.db.select({ count: sql<number>`count(*)` }).from(tasks)
        .where(and(eq(tasks.machineId, row.id), inArray(tasks.state, [...pendingStates]))).get()!.count,
    };
  }

  list(): MachineDto[] {
    return this.handle.db.select().from(machines).where(isNull(machines.removedAt)).orderBy(desc(machines.createdAt)).all().map((row) => this.dto(row));
  }

  detail(id: string): MachineDetailDto {
    const row = this.get(id);
    const token = decryptSecret(row.tokenCiphertext);
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const origin = getEnvironment().publicUrl;
    const installCommand = `installer=$(curl -fsSL ${quote(`${origin}/install.sh`)}) && eval "$installer" && bifurcation_install --panel ${quote(origin)} --token ${quote(token)}`;
    return { ...this.dto(row), token, installCommand, tasks: this.listTasks(id), issue: row.statusJson ? fromJsonString(MachineStatusSchema, row.statusJson).issue || null : null };
  }

  listTasks(id: string): TaskDto[] {
    this.get(id);
    return this.handle.db.select().from(tasks).where(eq(tasks.machineId, id)).orderBy(desc(tasks.createdAt)).limit(50).all().map(taskDto);
  }

  getTask(machineId: string, taskId: string): TaskDto {
    this.get(machineId);
    const task = this.handle.db.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.machineId, machineId))).get();
    if (!task) throw new AppError("TASK_NOT_FOUND", "任务不存在", 404);
    return taskDto(task);
  }

  resetToken(id: string): void {
    this.get(id);
    const token = newToken("bm_");
    this.handle.db.update(machines).set({ tokenHash: tokenHash(token), tokenCiphertext: encryptSecret(token),
      tokenGeneration: sql`${machines.tokenGeneration} + 1`, sessionEpoch: sql`${machines.sessionEpoch} + 1`,
      version: sql`${machines.version} + 1`, lastSeenAt: null,
    }).where(eq(machines.id, id)).run();
  }

  remove(id: string): void {
    this.get(id);
    this.handle.db.transaction((tx) => {
      tx.update(machines).set({ removedAt: Date.now(), sessionEpoch: sql`${machines.sessionEpoch} + 1` }).where(eq(machines.id, id)).run();
      tx.update(tasks).set({ state: "canceled", updatedAt: Date.now() }).where(and(eq(tasks.machineId, id), eq(tasks.state, "queued"))).run();
    });
  }

  enqueueInspect(id: string, requestKey: string, options: { includeLogs?: boolean; maxLogLines?: number; maxBytes?: number } = {}): TaskDto {
    const maxLogLines = options.maxLogLines ?? 100;
    const maxBytes = options.maxBytes ?? 262144;
    if (!Number.isInteger(maxLogLines) || maxLogLines < 1 || maxLogLines > 1000 || !Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 262144) {
      throw new AppError("INVALID_DIAGNOSTIC_LIMIT", "诊断范围超出限制", 422);
    }
    return this.enqueueTask(id, create(TaskSpecSchema, {
      operation: { case: "inspect", value: { includeLogs: options.includeLogs ?? false, maxLogLines, maxBytes } },
    }), requestKey);
  }

  enqueueTask(id: string, spec: TaskSpec, requestKey: string): TaskDto {
    const machine = this.get(id);
    const kinds = { inspect: TaskKind.INSPECT, applyConfig: TaskKind.APPLY_CONFIG,
      upgradeDaemon: TaskKind.UPGRADE_DAEMON, uninstall: TaskKind.UNINSTALL } as const;
    if (!spec.operation.case) throw new AppError("INVALID_TASK", "任务内容为空", 422);
    const kind = kinds[spec.operation.case];
    const payload = Buffer.from(toBinary(TaskSpecSchema, spec));
    if (payload.length > 1024 * 1024) throw new AppError("TASK_TOO_LARGE", "任务内容过大", 422);
    // Hash is defined over raw protobuf bytes, not base64 or reserialized JSON.
    const digest = sha256(payload);
    return this.handle.db.transaction((tx) => {
      const existing = tx.select().from(tasks).where(and(eq(tasks.machineId, id), eq(tasks.requestKey, requestKey))).get();
      if (existing) {
        if (existing.payloadHash !== digest) throw new AppError("REQUEST_CONFLICT", "请求标识已用于另一操作", 409);
        return taskDto(existing);
      }
      if (this.isUninstalled(id, machine.bindingEpoch)) throw new AppError("MACHINE_UNINSTALLED", "节点程序已卸载，需要重新绑定实例后接入", 409);
      if (!machine.installationId) throw new AppError("MACHINE_NOT_ENROLLED", "机器尚未接入", 409);
      if (!(JSON.parse(machine.supportedTasks) as number[]).includes(kind)) {
        throw new AppError("TASK_UNSUPPORTED", "此 daemon 尚不支持该任务", 409);
      }
      const now = Date.now();
      if (kind === TaskKind.APPLY_CONFIG) {
        // Only work that has not been accepted can be coalesced into a new target.
        tx.update(tasks).set({ state: "superseded", updatedAt: now }).where(and(
          eq(tasks.machineId, id), eq(tasks.bindingEpoch, machine.bindingEpoch),
          eq(tasks.kind, TaskKind.APPLY_CONFIG), eq(tasks.state, "queued"),
        )).run();
      }
      return taskDto(tx.insert(tasks).values({
        id: newId(), machineId: id, bindingEpoch: machine.bindingEpoch, kind,
        payload, payloadHash: digest, requestKey, createdAt: now, updatedAt: now,
      }).returning().get());
    });
  }

  pending(id: string, bindingEpoch: number): TaskRow[] {
    return this.handle.db.select().from(tasks).where(and(eq(tasks.machineId, id), eq(tasks.bindingEpoch, bindingEpoch), inArray(tasks.state, [...pendingStates])))
      .orderBy(asc(tasks.createdAt), sql`rowid ASC`).limit(1).all();
  }

  accept(row: MachineRow, sessionEpoch: bigint, taskId: string, hash: string): TaskRow {
    if (integerSequence(sessionEpoch, "session epoch") !== row.sessionEpoch) throw new ConnectError("STALE_SESSION", Code.FailedPrecondition);
    return this.handle.db.transaction((tx) => {
      const task = tx.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.machineId, row.id), eq(tasks.bindingEpoch, row.bindingEpoch))).get();
      if (!task) throw new ConnectError("task not found", Code.NotFound);
      if (task.payloadHash !== hash) throw new ConnectError("TASK_PAYLOAD_CONFLICT", Code.AlreadyExists);
      if (task.state === "canceled" || task.state === "superseded") throw new ConnectError("task is no longer executable", Code.FailedPrecondition);
      if (task.state === "succeeded" || task.state === "failed") throw new ConnectError("task is already complete", Code.FailedPrecondition);
      if (task.state !== "queued") return task;
      const active = tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.machineId, row.id), inArray(tasks.state, ["accepted", "running"]), ne(tasks.id, task.id))).get();
      if (active) throw new ConnectError("another task is active", Code.FailedPrecondition);
      return tx.update(tasks).set({ state: "accepted", updatedAt: Date.now() }).where(eq(tasks.id, task.id)).returning().get();
    });
  }

  reportStatus(row: MachineRow, sessionEpoch: bigint, sequence: bigint, status: MachineStatus): number {
    if (integerSequence(sessionEpoch, "session epoch") !== row.sessionEpoch) throw new ConnectError("STALE_SESSION", Code.FailedPrecondition);
    const seq = integerSequence(sequence, "status sequence");
    if (seq <= row.statusSequence) return row.statusSequence;
    this.handle.db.update(machines).set({ statusSequence: seq, statusJson: toJsonString(MachineStatusSchema, status), daemonVersion: status.daemonVersion, lastSeenAt: Date.now() })
      .where(and(eq(machines.id, row.id), eq(machines.sessionEpoch, row.sessionEpoch))).run();
    return seq;
  }

  reportTask(row: MachineRow, request: ReportTaskRequest): { committedSequence: bigint; terminal: boolean } {
    const seq = integerSequence(request.sequence, "task sequence");
    const hash = sha256(toBinary(ReportTaskRequestSchema, request));
    return this.handle.db.transaction((tx) => {
      const task = tx.select().from(tasks).where(and(eq(tasks.id, request.taskId), eq(tasks.machineId, row.id), eq(tasks.bindingEpoch, row.bindingEpoch))).get();
      if (!task) throw new ConnectError("task not found", Code.NotFound);
      if (task.payloadHash !== request.payloadSha256) throw new ConnectError("TASK_PAYLOAD_CONFLICT", Code.AlreadyExists);
      if (this.isUninstalled(row.id, row.bindingEpoch) && !(task.kind === TaskKind.UNINSTALL && task.state === "succeeded" && seq === task.progressSequence && hash === task.reportHash)) {
        throw new ConnectError("uninstalled machine may only replay its final uninstall result", Code.PermissionDenied);
      }
      const terminal = task.state === "succeeded" || task.state === "failed";
      if (seq <= task.progressSequence) {
        if (seq === task.progressSequence && hash !== task.reportHash) throw new ConnectError("TASK_REPORT_CONFLICT", Code.AlreadyExists);
        return { committedSequence: BigInt(task.progressSequence), terminal };
      }
      if (terminal || !["accepted", "running"].includes(task.state)) throw new ConnectError("invalid task transition", Code.FailedPrecondition);
      if (task.kind === TaskKind.UPGRADE_DAEMON && request.state === TaskState.SUCCEEDED) {
        const spec = fromBinary(TaskSpecSchema, task.payload);
        const expectedVersion = spec.operation.case === "upgradeDaemon" ? spec.operation.value.artifact?.version : undefined;
        const status = row.statusJson ? fromJsonString(MachineStatusSchema, row.statusJson) : undefined;
        if (!expectedVersion || row.statusSequence < 1 || row.daemonVersion !== expectedVersion || status?.daemonVersion !== expectedVersion || request.actualStatus?.daemonVersion !== expectedVersion) {
          throw new ConnectError("WAITING_FOR_DAEMON_RECONNECT", Code.FailedPrecondition);
        }
      }
      const state = request.state === TaskState.RUNNING ? "running" : request.state === TaskState.SUCCEEDED ? "succeeded" : request.state === TaskState.FAILED ? "failed" : null;
      if (!state) throw new ConnectError("invalid task state", Code.InvalidArgument);
      let diagnosticJson: string | null = null;
      if (request.diagnosticJson.length) {
        if (request.diagnosticJson.length > 262144) throw new ConnectError("diagnostic too large", Code.ResourceExhausted);
        try { diagnosticJson = JSON.stringify(JSON.parse(Buffer.from(request.diagnosticJson).toString("utf8"))); }
        catch { throw new ConnectError("invalid diagnostic JSON", Code.InvalidArgument); }
      }
      tx.update(tasks).set({
        state, progressSequence: seq, reportHash: hash, phase: request.phase || null,
        progressPercent: request.progressPercent ?? null, message: request.message || null,
        errorCode: request.errorCode || null, diagnosticJson, rollback: request.rollback, updatedAt: Date.now(),
      }).where(eq(tasks.id, task.id)).run();
      if (state === "succeeded" && task.kind === TaskKind.UNINSTALL) {
        tx.update(tasks).set({ state: "canceled", updatedAt: Date.now() }).where(and(eq(tasks.machineId, row.id), eq(tasks.state, "queued"))).run();
      }
      return { committedSequence: BigInt(seq), terminal: state !== "running" };
    });
  }
}


