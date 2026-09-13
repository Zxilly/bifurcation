import "server-only";
import { and, desc, eq, isNull } from "drizzle-orm";
import { create, fromBinary, fromJsonString } from "@bufbuild/protobuf";
import { GetConfigResponseSchema, MachineStatusSchema, TaskKind, TaskSpecSchema, type GetConfigRequest, type GetConfigResponse } from "@bifurcation/rpc";
import { z } from "zod";
import type { AuthorizationLayer, ConfigurationPreviewDto, ConfigurationPublishDto, MachineConfigurationDto, MachineConfigurationInput } from "@/contracts/configuration";
import { getDatabase, type DatabaseHandle } from "@/server/db";
import { configPreviews, configRevisions, machineConfigs, machineUserHistory, policyState } from "@/server/db/schema-proxy";
import { machines, tasks } from "@/server/db/schema-machines";
import { decryptSecret, encryptSecret, newId, sha256 } from "@/server/crypto";
import { AppError } from "@/server/http/errors";
import { MachineStore } from "@/server/modules/machines/store";
import { taskHub } from "@/server/rpc/task-hub";
import { jsonBytes, renderServer, validateSettings } from "@/server/adapters/sing-box";
import { PolicyStore } from "./policy";

const previewInput = z.object({ expectedVersion: z.number().int().min(0), settings: z.unknown() });
const publishInput = z.object({ previewId: z.uuid(), expectedVersion: z.number().int().min(0), requestKey: z.uuid() }).strict();

export class ConfigurationStore {
  constructor(private readonly handle: DatabaseHandle = getDatabase()) {}

  markForRebind(machineId: string) {
    new MachineStore(this.handle).get(machineId);
    // Explicit administrative rebind restores the last approved base on the new
    // installation; ordinary offline/unhealthy status never clears this marker.
    return this.handle.db.update(machineConfigs).set({ desiredPolicyRevision: 0 }).where(eq(machineConfigs.machineId, machineId)).run().changes;
  }

  get(machineId: string): MachineConfigurationDto {
    const machine = new MachineStore(this.handle).get(machineId);
    const row = this.handle.db.select().from(machineConfigs).where(eq(machineConfigs.machineId, machineId)).get();
    const latestPolicy = this.handle.db.select().from(policyState).where(eq(policyState.id, "global")).get()?.revision ?? 0;
    const status = machine.statusJson ? fromJsonString(MachineStatusSchema, machine.statusJson) : undefined;
    const latest = this.handle.db.select().from(tasks).where(and(eq(tasks.machineId, machineId), eq(tasks.bindingEpoch, machine.bindingEpoch), eq(tasks.kind, TaskKind.APPLY_CONFIG))).orderBy(desc(tasks.createdAt)).get();
    const desiredPolicy = Math.max(row?.desiredPolicyRevision ?? 0, latestPolicy);
    const applied = !!row?.desiredRevisionId && status?.appliedRevisionId === row.desiredRevisionId && status.appliedPolicyRevision >= BigInt(desiredPolicy);
    return {
      settings: row?.settingsCiphertext ? JSON.parse(decryptSecret(row.settingsCiphertext)) as MachineConfigurationInput : null,
      version: row?.version ?? 0,
      desiredRevisionId: row?.desiredRevisionId ?? null,
      desiredPolicyRevision: row?.desiredRevisionId ? String(desiredPolicy) : null,
      appliedRevisionId: status?.appliedRevisionId || null,
      appliedPolicyRevision: status?.appliedPolicyRevision ? String(status.appliedPolicyRevision) : null,
      reconciliation: !row?.desiredRevisionId ? "not_configured" : applied ? "applied" : latest?.state === "failed" ? "failed" : "pending",
      latestTask: latest ? new MachineStore(this.handle).getTask(machineId, latest.id) : null,
      bundledCoreVersion: status?.coreVersion || null,
    };
  }

  private ensureMachine(machineId: string) {
    const machine = new MachineStore(this.handle).get(machineId);
    if (new MachineStore(this.handle).isUninstalled(machineId, machine.bindingEpoch)) throw new AppError("MACHINE_UNINSTALLED", "节点已卸载，请移除记录或重新绑定实例后接入", 409);
    this.handle.db.insert(machineConfigs).values({ machineId }).onConflictDoNothing().run();
    return this.handle.db.select().from(machineConfigs).where(eq(machineConfigs.machineId, machineId)).get()!;
  }

  preview(machineId: string, input: unknown, createdBy: string): ConfigurationPreviewDto {
    const parsed = previewInput.parse(input);
    const settings = validateSettings(parsed.settings);
    return this.handle.db.transaction((tx) => {
      const row = this.ensureMachine(machineId);
      if (row.version !== parsed.expectedVersion) throw new AppError("VERSION_CONFLICT", "配置已更新，请刷新后重新预览", 409);
      const authorization = new PolicyStore(this.handle).refresh();
      const bytes = jsonBytes(renderServer(settings, authorization));
      const result = { previewId: newId(), expectedVersion: row.version, policyRevision: authorization.policyRevision, digest: sha256(bytes), finalJson: bytes.toString("utf8"), expiresAt: Date.now() + 10 * 60_000 };
      tx.insert(configPreviews).values({ id: result.previewId, machineId, settingsCiphertext: encryptSecret(JSON.stringify(settings)), renderedCiphertext: encryptSecret(result.finalJson), digest: result.digest, expectedVersion: row.version, policyRevision: Number(authorization.policyRevision), expiresAt: result.expiresAt, createdBy }).run();
      return result;
    });
  }

  publish(machineId: string, input: unknown, createdBy: string): ConfigurationPublishDto {
    const parsed = publishInput.parse(input);
    const result = this.handle.db.transaction((tx) => {
      const machine = new MachineStore(this.handle).get(machineId);
      const preview = tx.select().from(configPreviews).where(and(eq(configPreviews.id, parsed.previewId), eq(configPreviews.machineId, machineId), eq(configPreviews.createdBy, createdBy))).get();
      if (!preview) throw new AppError("PREVIEW_NOT_FOUND", "预览不存在，请重新预览", 404);
      if (preview.publishedRevisionId) {
        const existing = tx.select().from(tasks).where(and(eq(tasks.machineId, machineId), eq(tasks.requestKey, parsed.requestKey))).get();
        const spec = existing ? fromBinary(TaskSpecSchema, existing.payload) : undefined;
        const revisionId = spec?.operation.case === "applyConfig" ? spec.operation.value.revisionId : null;
        if (!existing || revisionId !== preview.publishedRevisionId) throw new AppError("PREVIEW_USED", "此预览已发布，请重新预览", 409);
        const revision = tx.select().from(configRevisions).where(eq(configRevisions.id, revisionId!)).get()!;
        return { revisionId: revision.id, version: revision.version, task: new MachineStore(this.handle).getTask(machineId, existing.id) };
      }
      if (preview.expiresAt <= Date.now()) throw new AppError("PREVIEW_EXPIRED", "预览已过期，请重新预览", 409);
      const row = this.ensureMachine(machineId);
      if (row.version !== parsed.expectedVersion || preview.expectedVersion !== row.version) throw new AppError("VERSION_CONFLICT", "配置已更新，请重新预览", 409);
      const authorization = new PolicyStore(this.handle).refresh();
      if (authorization.policyRevision !== String(preview.policyRevision)) throw new AppError("STALE_POLICY", "账号授权已变化，请重新预览", 409);
      if (machine.os !== "linux") throw new AppError("UNSUPPORTED_OS", "节点配置仅支持 Linux daemon", 422);
      const revisionId = newId();
      const version = row.version + 1;
      tx.insert(configRevisions).values({ id: revisionId, machineId, version, settingsCiphertext: preview.settingsCiphertext, renderedCiphertext: preview.renderedCiphertext, digest: preview.digest, policyRevision: preview.policyRevision, authorizedUserIds: JSON.stringify(authorization.users.map((user) => user.id)), createdAt: Date.now(), createdBy }).run();
      tx.update(machineConfigs).set({ settingsCiphertext: preview.settingsCiphertext, version, desiredRevisionId: revisionId, desiredPolicyRevision: preview.policyRevision }).where(eq(machineConfigs.machineId, machineId)).run();
      tx.update(configPreviews).set({ publishedRevisionId: revisionId }).where(eq(configPreviews.id, preview.id)).run();
      this.rememberUsers(machineId, authorization);
      const spec = create(TaskSpecSchema, { operation: { case: "applyConfig", value: { revisionId, policyRevision: BigInt(preview.policyRevision) } } });
      const task = new MachineStore(this.handle).enqueueTask(machineId, spec, parsed.requestKey);
      return { revisionId, version, task };
    });
    taskHub.wake(machineId);
    return result;
  }

  private rememberUsers(machineId: string, authorization: AuthorizationLayer) {
    for (const user of authorization.users) this.handle.db.insert(machineUserHistory).values({ machineId, userId: user.id }).onConflictDoNothing().run();
  }

  getConfig(machineId: string, request: GetConfigRequest): GetConfigResponse {
    const machine = new MachineStore(this.handle).get(machineId);
    if (new MachineStore(this.handle).isUninstalled(machineId, machine.bindingEpoch)) throw new AppError("MACHINE_UNINSTALLED", "节点已完成卸载，不能获取新的代理凭据", 403);
    const latest = new PolicyStore(this.handle).refresh();
    if (request.authorizationOnly) return create(GetConfigResponseSchema, { latestAuthorizationJson: jsonBytes(latest), latestPolicyRevision: BigInt(latest.policyRevision) });
    const target = this.handle.db.select().from(machineConfigs).where(eq(machineConfigs.machineId, machineId)).get();
    const revisionId = request.revisionId || target?.desiredRevisionId;
    const revision = revisionId && this.handle.db.select().from(configRevisions).where(and(eq(configRevisions.id, revisionId), eq(configRevisions.machineId, machineId))).get();
    if (!revision) throw new AppError("CONFIG_NOT_FOUND", "配置版本不存在", 404);
    return create(GetConfigResponseSchema, { revisionId: revision.id, configJson: Buffer.from(decryptSecret(revision.renderedCiphertext)), configSha256: revision.digest, policyRevision: BigInt(revision.policyRevision), latestAuthorizationJson: jsonBytes(latest), latestPolicyRevision: BigInt(latest.policyRevision) });
  }

  reconcile(now = Date.now()): string[] {
    const authorization = new PolicyStore(this.handle).refresh(now);
    const configured = this.handle.db.select({ configuration: machineConfigs, machine: machines }).from(machineConfigs).innerJoin(machines, eq(machineConfigs.machineId, machines.id)).where(isNull(machines.removedAt)).all();
    const changed: string[] = [];
    for (const { configuration, machine } of configured) {
      if (new MachineStore(this.handle).isUninstalled(machine.id, machine.bindingEpoch)) continue;
      if (!configuration.settingsCiphertext || configuration.desiredPolicyRevision >= Number(authorization.policyRevision)) continue;
      if (!(JSON.parse(machine.supportedTasks) as number[]).includes(TaskKind.APPLY_CONFIG) || !machine.installationId) continue;
      try { this.handle.db.transaction((tx) => {
        const current = tx.select().from(machineConfigs).where(eq(machineConfigs.machineId, machine.id)).get()!;
        if (!current.settingsCiphertext || current.desiredPolicyRevision >= Number(authorization.policyRevision)) return;
        const settings = JSON.parse(decryptSecret(current.settingsCiphertext)) as MachineConfigurationInput;
        const bytes = jsonBytes(renderServer(settings, authorization));
        const revisionId = newId();
        const version = current.version + 1;
        tx.insert(configRevisions).values({ id: revisionId, machineId: machine.id, version, settingsCiphertext: current.settingsCiphertext, renderedCiphertext: encryptSecret(bytes.toString("utf8")), digest: sha256(bytes), policyRevision: Number(authorization.policyRevision), authorizedUserIds: JSON.stringify(authorization.users.map((user) => user.id)), createdAt: now }).run();
        tx.update(machineConfigs).set({ version, desiredRevisionId: revisionId, desiredPolicyRevision: Number(authorization.policyRevision) }).where(eq(machineConfigs.machineId, machine.id)).run();
        this.rememberUsers(machine.id, authorization);
        const spec = create(TaskSpecSchema, { operation: { case: "applyConfig", value: { revisionId, policyRevision: BigInt(authorization.policyRevision) } } });
        new MachineStore(this.handle).enqueueTask(machine.id, spec, `policy:${machine.id}:${authorization.policyRevision}`);
        changed.push(machine.id);
      }); } catch (error) { console.error("Machine authorization reconciliation failed", { machineId: machine.id, error }); }
    }
    for (const machineId of changed) taskHub.wake(machineId);
    return changed;
  }
}
