import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromJson, toJson, toBinary } from "@bufbuild/protobuf";
import {
  AcceptTaskRequestSchema, AcceptTaskResponseSchema, CoreHealth, InstallationSchema, MachineStatusSchema,
  ReportStatusRequestSchema, ReportTaskRequestSchema, TaskKind, TaskSpecSchema, TaskState,
} from "@bifurcation/rpc";
import { openDatabase, type DatabaseHandle } from "@/server/db";
import { MachineStore } from "@/server/modules/machines/store";
import { sha256 } from "@/server/crypto";
import { TaskHub } from "@/server/rpc/task-hub";
import { createMachineRouter } from "@/server/rpc/machine-service";
import { handleConnectRequest } from "@/server/rpc/web-adapter";

describe("machine persistence and Connect boundary", () => {
  let directory: string;
  let database: DatabaseHandle;
  let store: MachineStore;
  let hub: TaskHub;
  const installationId = "2b147888-68bf-41b3-91f7-7474db48cd63";

  beforeEach(() => {
    process.env.BIFURCATION_APP_KEY = "12".repeat(32);
    process.env.BIFURCATION_PUBLIC_URL = "http://localhost:3000";
    directory = mkdtempSync(join(tmpdir(), "bifurcation-machine-"));
    database = openDatabase(join(directory, "panel.sqlite"));
    store = new MachineStore(database);
    hub = new TaskHub();
  });
  afterEach(() => { hub.shutdown(); database.sqlite.close(); rmSync(directory, { recursive: true, force: true }); });

  const initialIdentity = () => create(InstallationSchema, { installationId, bindingEpoch: 0n });

  function enroll() {
    const machine = store.create({ name: "Test machine", address: "node.example.com", region: "" });
    const bound = store.bind(machine.id, initialIdentity(), { daemonVersion: "test", os: "linux", arch: "amd64", supportedTasks: [TaskKind.INSPECT] });
    return { machine, bound, identity: create(InstallationSchema, { installationId, bindingEpoch: BigInt(bound.bindingEpoch) }) };
  }

  it("keeps machine tokens recoverable and fences foreign installations and old connections", () => {
    const { machine, bound, identity } = enroll();
    expect(store.detail(machine.id).token).toBe(machine.token);
    expect(() => store.bind(machine.id, create(InstallationSchema, { installationId: "another-installation-id", bindingEpoch: 0n }), { daemonVersion: "test", os: "linux", arch: "amd64", supportedTasks: [] })).toThrow("INSTANCE_CONFLICT");
    const reconnected = store.bind(machine.id, identity, { daemonVersion: "test", os: "linux", arch: "amd64", supportedTasks: [TaskKind.INSPECT] });
    expect(reconnected.sessionEpoch).toBe(bound.sessionEpoch + 1);
    expect(() => store.reportStatus(reconnected, BigInt(bound.sessionEpoch), 1n, create(MachineStatusSchema))).toThrow("STALE_SESSION");
    store.resetToken(machine.id);
    expect(() => store.authenticate(`Bearer ${machine.token}`)).toThrow("invalid machine token");
    expect(store.get(machine.id).installationId).toBe(installationId);
  });

  it("accepts exact protobuf task bytes and commits terminal reports only once", async () => {
    const { machine, bound, identity } = enroll();
    const task = store.enqueueInspect(machine.id, "same-request");
    expect(store.enqueueInspect(machine.id, "same-request").id).toBe(task.id);
    const notice = store.pending(machine.id, bound.bindingEpoch)[0];
    const request = create(AcceptTaskRequestSchema, { installation: identity, sessionEpoch: BigInt(bound.sessionEpoch), taskId: task.id, payloadSha256: notice.payloadHash });
    const response = await handleConnectRequest(createMachineRouter(store, hub), new Request("http://localhost/rpc/bifurcation.v1.MachineService/AcceptTask", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${machine.token}` },
      body: JSON.stringify(toJson(AcceptTaskRequestSchema, request)),
    }));
    expect(response.status).toBe(200);
    const accepted = fromJson(AcceptTaskResponseSchema, await response.json());
    expect(sha256(accepted.payload)).toBe(accepted.payloadSha256);
    expect(accepted.payload).toEqual(new Uint8Array(notice.payload));
    const report = create(ReportTaskRequestSchema, { installation: identity, taskId: task.id, payloadSha256: notice.payloadHash, sequence: 2n, state: TaskState.SUCCEEDED, phase: "completed", diagnosticJson: new TextEncoder().encode('{"os":"linux"}') });
    expect(store.reportTask(bound, report)).toEqual({ committedSequence: 2n, terminal: true });
    expect(store.reportTask(bound, report)).toEqual({ committedSequence: 2n, terminal: true });
    expect(() => store.accept(bound, BigInt(bound.sessionEpoch), task.id, notice.payloadHash)).toThrow("task is already complete");
    expect(() => store.reportTask(bound, { ...report, message: "different result" })).toThrow("TASK_REPORT_CONFLICT");
    expect(() => store.reportTask(bound, { ...report, sequence: 3n, state: TaskState.RUNNING })).toThrow("invalid task transition");
    expect(store.listTasks(machine.id)[0].diagnostic).toEqual({ os: "linux" });
    database.sqlite.close();
    database = openDatabase(join(directory, "panel.sqlite"));
    store = new MachineStore(database);
    expect(store.listTasks(machine.id)[0].state).toBe("succeeded");
  });

  it("does not accept an unoffered task or let stale status overwrite new data", () => {
    const { machine, bound, identity } = enroll();
    const first = store.enqueueInspect(machine.id, "one");
    const second = store.enqueueInspect(machine.id, "two");
    const queued = store.pending(machine.id, bound.bindingEpoch)[0];
    store.accept(bound, BigInt(bound.sessionEpoch), first.id, queued.payloadHash);
    expect(() => store.accept(bound, BigInt(bound.sessionEpoch), second.id, queued.payloadHash)).toThrow("another task is active");
    const status = create(MachineStatusSchema, { observedAtUnixMs: BigInt(Date.now()), daemonVersion: "new", coreHealth: CoreHealth.NOT_CONFIGURED });
    store.reportStatus(bound, BigInt(bound.sessionEpoch), 2n, status);
    const fresh = store.get(machine.id);
    store.assertInstallation(fresh, identity);
    store.reportStatus(fresh, BigInt(bound.sessionEpoch), 1n, { ...status, daemonVersion: "old" });
    expect(store.detail(machine.id).daemonVersion).toBe("new");
  });

  it("returns protocol errors for missing credentials and invalid status", async () => {
    const { machine, bound, identity } = enroll();
    const router = createMachineRouter(store, hub);
    const url = "http://localhost/rpc/bifurcation.v1.MachineService/ReportStatus";
    const unauthenticated = await handleConnectRequest(router, new Request(url, { method: "POST", headers: { "Content-Type": "application/proto" }, body: new Uint8Array() }));
    expect(unauthenticated.status).toBe(401);
    const payload = toBinary(ReportStatusRequestSchema, create(ReportStatusRequestSchema, { installation: identity, sessionEpoch: BigInt(bound.sessionEpoch), sequence: 1n }));
    const invalid = await handleConnectRequest(router, new Request(url, { method: "POST", headers: { "Content-Type": "application/proto", Authorization: `Bearer ${machine.token}` }, body: Buffer.from(payload) }));
    expect(invalid.status).toBe(400);
  });

  it("coalesces only queued configuration tasks and preserves an accepted revision", () => {
    const { machine, identity } = enroll();
    const bound = store.bind(machine.id, identity, { daemonVersion: "test", os: "linux", arch: "amd64", supportedTasks: [TaskKind.INSPECT, TaskKind.APPLY_CONFIG] });
    const configuration = (revision: string, policy: bigint) => create(TaskSpecSchema, {
      operation: { case: "applyConfig", value: { revisionId: revision, policyRevision: policy } },
    });
    const old = store.enqueueTask(machine.id, configuration("old", 1n), "config-1");
    const current = store.enqueueTask(machine.id, configuration("current", 2n), "config-2");
    expect(store.listTasks(machine.id).find((task) => task.id === old.id)?.state).toBe("superseded");
    const pending = store.pending(machine.id, bound.bindingEpoch)[0];
    expect(pending.id).toBe(current.id);
    store.accept(bound, BigInt(bound.sessionEpoch), pending.id, pending.payloadHash);
    store.enqueueTask(machine.id, configuration("newest", 3n), "config-3");
    expect(store.listTasks(machine.id).find((task) => task.id === current.id)?.state).toBe("accepted");
    expect(store.pending(machine.id, bound.bindingEpoch)[0].id).toBe(current.id);
  });

  it("keeps uninstall acknowledgement replay available while fencing retired work and new instances", () => {
    const { machine, identity } = enroll();
    const bound = store.bind(machine.id, identity, { daemonVersion: "test", os: "linux", arch: "amd64", supportedTasks: [TaskKind.INSPECT, TaskKind.UNINSTALL] });
    const uninstall = store.enqueueTask(machine.id, create(TaskSpecSchema, { operation: { case: "uninstall", value: {} } }), "uninstall");
    const pending = store.pending(machine.id, bound.bindingEpoch)[0];
    store.accept(bound, BigInt(bound.sessionEpoch), pending.id, pending.payloadHash);
    const follower = store.enqueueInspect(machine.id, "queued-after-uninstall");
    const report = create(ReportTaskRequestSchema, { installation: identity, taskId: uninstall.id, payloadSha256: pending.payloadHash, sequence: 1n, state: TaskState.SUCCEEDED, phase: "completed" });
    store.reportTask(bound, report);
    expect(store.detail(machine.id).uninstalled).toBe(true);
    expect(store.getTask(machine.id, follower.id).state).toBe("canceled");
    let rejected: unknown;
    try { store.enqueueInspect(machine.id, "new-inspect"); } catch (error) { rejected = error; }
    expect(rejected).toMatchObject({ code: "MACHINE_UNINSTALLED" });
    expect(store.reportTask(bound, report)).toEqual({ committedSequence: 1n, terminal: true });
    expect(() => store.reportTask(bound, { ...report, message: "changed" })).toThrow("may only replay");
    const rebound = store.rebind(machine.id, machine.version);
    expect(rebound.token).not.toBe(machine.token);
    expect(rebound.uninstalled).toBe(false);
    expect(rebound.installationId).toBeNull();
    expect(() => store.authenticate(`Bearer ${machine.token}`)).toThrow("invalid machine token");
    const fresh = store.bind(machine.id, create(InstallationSchema, { installationId: "fresh-installation-after-uninstall", bindingEpoch: 0n }), { daemonVersion: "test", os: "linux", arch: "amd64", supportedTasks: [TaskKind.INSPECT] });
    expect(fresh.bindingEpoch).toBe(bound.bindingEpoch + 1);
    expect(store.getTask(machine.id, uninstall.id).state).toBe("succeeded");
  });

  it("requires a target-version session status before confirming a daemon upgrade", () => {
    const { machine, identity } = enroll();
    let bound = store.bind(machine.id, identity, { daemonVersion: "0.0.0-dev", os: "linux", arch: "amd64", supportedTasks: [TaskKind.UPGRADE_DAEMON] });
    store.reportStatus(bound, BigInt(bound.sessionEpoch), 1n, create(MachineStatusSchema, { daemonVersion: "0.0.0-dev", observedAtUnixMs: BigInt(Date.now()) }));
    const task = store.enqueueTask(machine.id, create(TaskSpecSchema, { operation: { case: "upgradeDaemon", value: { artifact: { version: "0.1.0" } } } }), "upgrade-proof");
    const pending = store.pending(machine.id, bound.bindingEpoch)[0];
    store.accept(bound, BigInt(bound.sessionEpoch), task.id, pending.payloadHash);
    const report = create(ReportTaskRequestSchema, { installation: identity, taskId: task.id, payloadSha256: pending.payloadHash, sequence: 2n, state: TaskState.SUCCEEDED, phase: "completed", actualStatus: { daemonVersion: "0.1.0", observedAtUnixMs: BigInt(Date.now()) } });
    expect(() => store.reportTask(store.get(machine.id), report)).toThrow("WAITING_FOR_DAEMON_RECONNECT");
    bound = store.bind(machine.id, identity, { daemonVersion: "0.1.0", os: "linux", arch: "amd64", supportedTasks: [TaskKind.UPGRADE_DAEMON] });
    expect(() => store.reportTask(bound, report)).toThrow("WAITING_FOR_DAEMON_RECONNECT");
    store.reportStatus(bound, BigInt(bound.sessionEpoch), 1n, create(MachineStatusSchema, { daemonVersion: "0.1.0", observedAtUnixMs: BigInt(Date.now()) }));
    expect(store.reportTask(store.get(machine.id), report)).toEqual({ committedSequence: 2n, terminal: true });
    bound = store.bind(machine.id, identity, { daemonVersion: "0.2.0", os: "linux", arch: "amd64", supportedTasks: [TaskKind.UPGRADE_DAEMON] });
    expect(store.reportTask(bound, report)).toEqual({ committedSequence: 2n, terminal: true });
  });

  it("cancels waiting streams promptly and old cleanup does not remove the replacement", async () => {
    const old = hub.open("machine");
    const waiting = old.wait(new AbortController().signal, 60_000);
    const rejected = expect(waiting).rejects.toThrow("connection replaced");
    const current = hub.open("machine");
    await rejected;
    hub.release("machine", old);
    expect(hub.size).toBe(1);
    const wake = current.wait(new AbortController().signal, 60_000);
    hub.wake("machine");
    await wake;
    hub.release("machine", current);
    expect(hub.size).toBe(0);
  });
});

