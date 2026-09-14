import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromBinary } from "@bufbuild/protobuf";
import { CoreHealth, InstallationSchema, MachineStatusSchema, MaintenanceStatus, TaskKind, TaskSpecSchema } from "@bifurcation/rpc";
import { openDatabase, type DatabaseHandle } from "@/server/db";
import { tasks } from "@/server/db/schema-machines";
import { MachineStore } from "@/server/modules/machines/store";
import { ReleaseStore } from "@/server/releases/store";
import { newId, sha256 } from "@/server/crypto";

describe("daemon releases with a bundled proxy core", () => {
  let directory: string;
  let database: DatabaseHandle;
  let machines: MachineStore;
  let releases: ReleaseStore;
  let machineId: string;
  function manifest(suffix = "one", bundledCoreVersion = "1.14.0") {
    const artifacts = Object.fromEntries(["amd64", "arm64"].map((arch) => [arch, { filename: `daemon-linux-${arch}`, sha256: sha256(`daemon-${arch}-${suffix}`), sizeBytes: 32 }]));
    writeFileSync(join(directory, "daemon-manifest.json"), JSON.stringify({ version: "0.1.0", bundledCoreVersion, protocolVersion: 1, artifacts }));
  }
  beforeEach(() => {
    process.env.BIFURCATION_APP_KEY = "78".repeat(32);
    process.env.BIFURCATION_PUBLIC_URL = "http://localhost:3000";
    directory = mkdtempSync(join(tmpdir(), "bifurcation-upgrades-"));
    process.env.BIFURCATION_ARTIFACT_DIRECTORY = directory;
    manifest();
    database = openDatabase(join(directory, "panel.sqlite"));
    machines = new MachineStore(database); releases = new ReleaseStore(database);
    machineId = machines.create({ name: "Upgradeable node", address: "node.test", region: "" }).id;
    const bound = machines.bind(machineId, create(InstallationSchema, { installationId: "upgrade-test-installation" }), { daemonVersion: "0.0.1", os: "linux", arch: "amd64", supportedTasks: [TaskKind.APPLY_CONFIG, TaskKind.UPGRADE_DAEMON, TaskKind.UNINSTALL] });
    machines.reportStatus(bound, BigInt(bound.sessionEpoch), 1n, create(MachineStatusSchema, { observedAtUnixMs: BigInt(Date.now()), daemonVersion: "0.0.1", coreVersion: "1.14.0", coreHealth: CoreHealth.HEALTHY }));
  });
  afterEach(() => { database.sqlite.close(); delete process.env.BIFURCATION_ARTIFACT_DIRECTORY; rmSync(directory, { recursive: true, force: true }); });

  it("pins daemon bytes, preserves observed versions until a node report and makes retries idempotent", () => {
    const candidate = releases.get(machineId).daemon;
    expect(candidate.executable).toBe(true);
    const input = { expectedSha256: candidate.sha256, requestKey: newId() };
    const result = releases.enqueue(machineId, input);
    expect(result.task.kind).toBe("upgrade_daemon");
    expect(machines.get(machineId).daemonVersion).toBe("0.0.1");
    manifest("changed");
    expect(releases.enqueue(machineId, input)).toEqual(result);
    expect(database.db.select().from(tasks).all()).toHaveLength(1);
    expect(releases.get(machineId).activeTask?.id).toBe(result.task.id);
    const spec = fromBinary(TaskSpecSchema, database.db.select().from(tasks).get()!.payload);
    expect(spec.operation.case).toBe("upgradeDaemon");
    if (spec.operation.case === "upgradeDaemon") expect(spec.operation.value.artifact?.url).toBe("http://localhost:3000/artifacts/daemon-linux-amd64");
  });
  it("refuses manifest drift and does not accept a caller-supplied artifact URL", () => {
    const candidate = releases.get(machineId).daemon;
    manifest("changed-before-submit");
    expect(() => releases.enqueue(machineId, { expectedSha256: candidate.sha256, requestKey: newId() })).toThrow("可用制品已变化");
    expect(database.db.select().from(tasks).all()).toHaveLength(0);
    expect(() => releases.enqueue(machineId, { expectedSha256: releases.get(machineId).daemon.sha256, requestKey: newId(), url: "https://untrusted.example/payload" })).toThrow();
    expect(database.db.select().from(tasks).all()).toHaveLength(0);
  });
  it("exposes bundled core versions as metadata while upgrades only target the daemon", () => {
    manifest("next", "1.14.1");
    const available = releases.get(machineId);
    expect(available.bundledCoreVersion).toBe("1.14.0");
    expect(available.availableBundledCoreVersion).toBe("1.14.1");
    expect(available).not.toHaveProperty("core");
    releases.enqueue(machineId, { expectedSha256: available.daemon.sha256, requestKey: newId() });
    expect(releases.get(machineId).bundledCoreVersion).toBe("1.14.0");
    const machine = machines.get(machineId);
    machines.reportStatus(machine, BigInt(machine.sessionEpoch), 2n, create(MachineStatusSchema, { observedAtUnixMs: BigInt(Date.now()), daemonVersion: "0.1.0", coreVersion: "1.14.1", coreHealth: CoreHealth.HEALTHY }));
    expect(releases.get(machineId).bundledCoreVersion).toBe("1.14.1");
  });
  it("returns disabled metadata instead of a false available release when the manifest is missing", () => {
    rmSync(join(directory, "daemon-manifest.json"));
    const result = releases.get(machineId);
    expect(result.daemon.availableVersion).toBeNull();
    expect(result.daemon.executable).toBe(false);
    expect(result.daemon.disabledReason).toContain("制品尚未就绪");
    expect(result.daemon.currentVersion).toBe("0.0.1");
    expect(result.bundledCoreVersion).toBe("1.14.0");
  });
  it("reports container maintenance guidance and refuses to queue a self-upgrade", () => {
    const current = machines.get(machineId);
    const bound = machines.bind(machineId, create(InstallationSchema, {
      installationId: current.installationId!, bindingEpoch: BigInt(current.bindingEpoch),
    }), { daemonVersion: "0.0.1", os: "linux", arch: "amd64", supportedTasks: [TaskKind.INSPECT, TaskKind.APPLY_CONFIG] });
    machines.reportStatus(bound, BigInt(bound.sessionEpoch), 1n, create(MachineStatusSchema, {
      daemonVersion: "0.0.1", maintenanceStatus: MaintenanceStatus.CONTAINER,
    }));
    const candidate = releases.get(machineId).daemon;
    expect(candidate.executable).toBe(false);
    expect(candidate.disabledReason).toContain("更新镜像并重建容器");
    expect(() => releases.enqueue(machineId, { expectedSha256: candidate.sha256, requestKey: newId() })).toThrow("更新镜像并重建容器");
    expect(() => releases.uninstall(machineId, { requestKey: newId() })).toThrow("更新镜像并重建容器");
    // A status report alone cannot grant an unadvertised maintenance task.
    machines.reportStatus(bound, BigInt(bound.sessionEpoch), 2n, create(MachineStatusSchema, {
      daemonVersion: "0.0.1", maintenanceStatus: MaintenanceStatus.AVAILABLE,
    }));
    expect(releases.get(machineId).daemon.executable).toBe(false);
    expect(() => releases.uninstall(machineId, { requestKey: newId() })).toThrow();
    // Conversely, a later installation failure is restrictive even when the
    // connection previously advertised both maintenance tasks.
    const capable = machines.bind(machineId, create(InstallationSchema, {
      installationId: bound.installationId!, bindingEpoch: BigInt(bound.bindingEpoch),
    }), { daemonVersion: "0.0.1", os: "linux", arch: "amd64", supportedTasks: [TaskKind.UPGRADE_DAEMON, TaskKind.UNINSTALL] });
    machines.reportStatus(capable, BigInt(capable.sessionEpoch), 1n, create(MachineStatusSchema, {
      daemonVersion: "0.0.1", maintenanceStatus: MaintenanceStatus.CONTAINER,
    }));
    expect(releases.get(machineId).daemon.executable).toBe(false);
    expect(() => releases.uninstall(machineId, { requestKey: newId() })).toThrow("更新镜像并重建容器");
    expect(database.db.select().from(tasks).all()).toHaveLength(0);
  });
  it("does not interpret missing maintenance reports as a specific installation mode", () => {
    const current = machines.get(machineId);
    const bound = machines.bind(machineId, create(InstallationSchema, {
      installationId: current.installationId!, bindingEpoch: BigInt(current.bindingEpoch),
    }), { daemonVersion: "legacy", os: "linux", arch: "amd64", supportedTasks: [TaskKind.INSPECT] });
    machines.reportStatus(bound, BigInt(bound.sessionEpoch), 1n, create(MachineStatusSchema, { daemonVersion: "legacy" }));
    const candidate = releases.get(machineId).daemon;
    expect(candidate.executable).toBe(false);
    expect(candidate.disabledReason).toContain("未上报维护原因");
    expect(candidate.disabledReason).not.toContain("容器");
  });
});
