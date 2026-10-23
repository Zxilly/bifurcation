import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { InstallationSchema, WatchTasksRequestSchema, WatchTasksResponseSchema, TaskKind } from "@bifurcation/rpc";
import { openDatabase, type DatabaseHandle } from "@/server/db";
import { MachineStore } from "@/server/modules/machines/store";
import { TaskHub } from "@/server/rpc/task-hub";
import { createMachineRouter } from "@/server/rpc/machine-service";
import { handleConnectRequest } from "@/server/rpc/web-adapter";

describe("Connect streaming Web Request/Response adapter", () => {
  let directory: string;
  let database: DatabaseHandle;
  let store: MachineStore;
  let hub: TaskHub;
  beforeEach(() => {
    process.env.BIFURCATION_APP_KEY = "45".repeat(32);
    process.env.BIFURCATION_PUBLIC_URL = "http://localhost:3000";
    directory = mkdtempSync(join(tmpdir(), "bifurcation-stream-"));
    database = openDatabase(join(directory, "panel.sqlite"));
    store = new MachineStore(database); hub = new TaskHub();
  });
  afterEach(() => { hub.shutdown(); database.sqlite.close(); rmSync(directory, { recursive: true, force: true }); });

  async function connect(token: string, epoch = 0n, signal?: AbortSignal) {
    const message = toBinary(WatchTasksRequestSchema, create(WatchTasksRequestSchema, { installation: { installationId: "integration-installation-id", bindingEpoch: epoch }, daemonVersion: "test", protocolVersion: 1, supportedTasks: [TaskKind.INSPECT], os: "linux", arch: "amd64" }));
    const prefix = Buffer.alloc(5); prefix.writeUInt32BE(message.length, 1);
    const response = await handleConnectRequest(createMachineRouter(store, hub, { scanMs: 60_000, heartbeatMs: 60_000 }), new Request("http://localhost:3000/rpc/bifurcation.v1.MachineService/WatchTasks", { method: "POST", signal, headers: { authorization: `Bearer ${token}`, "content-type": "application/connect+proto", "connect-protocol-version": "1" }, body: Buffer.concat([prefix, message]) }));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const reader = response.body!.getReader();
    return reader;
  }
  async function readEvent(reader: ReadableStreamDefaultReader<Uint8Array>) {
    const result = await reader.read();
    expect(result.done).toBe(false);
    const bytes = Buffer.from(result.value!);
    expect(bytes[0]).toBe(0);
    expect(bytes.readUInt32BE(1)).toBe(bytes.length - 5);
    return fromBinary(WatchTasksResponseSchema, bytes.subarray(5));
  }

  it("streams a persisted task after subscription and cancels an outstanding read without waiting for heartbeat", async () => {
    const machine = store.create({ name: "Streaming node", address: "node.example", region: "" });
    const reader = await connect(machine.token);
    const session = await readEvent(reader);
    expect(session.event.case).toBe("session");
    expect(hub.size).toBe(1);
    const task = store.enqueueInspect(machine.id, "stream-task");
    hub.wake(machine.id);
    const notification = await readEvent(reader);
    expect(notification.event.case).toBe("task");
    if (notification.event.case === "task") expect(notification.event.value.taskId).toBe(task.id);
    const waiting = reader.read();
    await reader.cancel("client disconnected");
    expect((await waiting).done).toBe(true);
    expect(hub.size).toBe(0);
  });

  it("old response cleanup cannot close a replacement stream", async () => {
    const machine = store.create({ name: "Replacement node", address: "node.example", region: "" });
    const oldReader = await connect(machine.token);
    const first = await readEvent(oldReader);
    expect(first.event.case).toBe("session");
    const currentReader = await connect(machine.token, 1n);
    const current = await readEvent(currentReader);
    expect(current.event.case).toBe("session");
    await oldReader.cancel();
    expect(hub.size).toBe(1);
    const task = store.enqueueInspect(machine.id, "replacement-task");
    hub.wake(machine.id);
    const notification = await readEvent(currentReader);
    expect(notification.event.case).toBe("task");
    if (notification.event.case === "task") expect(notification.event.value.taskId).toBe(task.id);
    await currentReader.cancel();
    expect(hub.size).toBe(0);
  });

  it.each([false, true])("rejects a WatchTasks body completed after shutdown without changing its binding (enrolled: %s)", async (enrolled) => {
    const machine = store.create({ name: "Delayed node", address: "node.example", region: "" });
    const installation = create(InstallationSchema, { installationId: "delayed-installation-id", bindingEpoch: 0n });
    const info = { daemonVersion: "test", os: "linux", arch: "amd64", supportedTasks: [TaskKind.INSPECT] };
    if (enrolled) installation.bindingEpoch = BigInt(store.bind(machine.id, installation, info).bindingEpoch);
    const original = store.get(machine.id);
    const message = toBinary(WatchTasksRequestSchema, create(WatchTasksRequestSchema, { installation, ...info, protocolVersion: 1 }));
    const prefix = Buffer.alloc(5); prefix.writeUInt32BE(message.length, 1);
    const reading = Promise.withResolvers<void>();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(value) { controller = value; value.enqueue(prefix); },
      pull() { reading.resolve(); },
    }, { highWaterMark: 0 });
    const pending = handleConnectRequest(createMachineRouter(store, hub), new Request("http://localhost:3000/rpc/bifurcation.v1.MachineService/WatchTasks", {
      method: "POST", headers: { authorization: `Bearer ${machine.token}`, "content-type": "application/connect+proto", "connect-protocol-version": "1" },
      body, duplex: "half",
    } as RequestInit));
    // The real Connect transport has consumed the frame header and is waiting
    // for its payload when runtime shutdown stops accepting task streams.
    await reading.promise;
    hub.shutdown();
    controller.enqueue(message);
    controller.close();
    const response = await pending;
    const reader = response.body!.getReader();
    try {
      const frame = await reader.read();
      expect(frame.done).toBe(false);
      const bytes = Buffer.from(frame.value!);
      expect(bytes[0]).toBe(2);
      expect(JSON.parse(bytes.subarray(5).toString("utf8"))).toMatchObject({ error: { code: "unavailable" } });
      expect((await reader.read()).done).toBe(true);
      expect(store.get(machine.id)).toEqual(original);
      expect(hub.size).toBe(0);
      expect(() => hub.open(machine.id)).toThrow("panel shutting down");
    } finally { await reader.cancel(); }
  });
});
