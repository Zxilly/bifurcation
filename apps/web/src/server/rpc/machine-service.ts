import "server-only";
import { Code, ConnectError, createConnectRouter, type HandlerContext } from "@connectrpc/connect";
import { MachineService, TaskKind, type MachineStatus } from "@bifurcation/rpc";
import { MachineStore, integerSequence } from "@/server/modules/machines/store";
import { ConfigurationStore } from "@/server/configuration/store";
import { UsageStore } from "@/server/usage/store";
import { AppError } from "@/server/http/errors";
import { TaskHub, taskHub } from "./task-hub";

function domainCall<T>(action: () => T): T {
  try { return action(); }
  catch (error) {
    if (error instanceof AppError) {
      const codes: Record<number, Code> = {
        400: Code.InvalidArgument, 401: Code.Unauthenticated, 403: Code.PermissionDenied,
        404: Code.NotFound, 409: Code.FailedPrecondition, 413: Code.ResourceExhausted,
        422: Code.InvalidArgument, 429: Code.ResourceExhausted,
      };
      throw new ConnectError(`${error.code}: ${error.message}`, codes[error.status] ?? Code.Internal);
    }
    throw error;
  }
}

function validateStatus(status: MachineStatus | undefined) {
  if (!status) throw new ConnectError("status is required", Code.InvalidArgument);
  integerSequence(status.observedAtUnixMs, "observed time");
  if (status.observedAtUnixMs > BigInt(Date.now() + 300_000)) throw new ConnectError("clock is too far ahead", Code.InvalidArgument);
  if (status.issue.length > 4096 || status.daemonVersion.length > 128 || status.coreVersion.length > 128) throw new ConnectError("status field too long", Code.InvalidArgument);
  if (status.appliedConfigSha256 && !/^[a-f0-9]{64}$/.test(status.appliedConfigSha256)) throw new ConnectError("invalid applied configuration hash", Code.InvalidArgument);
  for (const value of [status.memoryUsedBytes, status.memoryTotalBytes, status.diskFreeBytes, status.connections, status.networkRxBytes, status.networkTxBytes]) {
    if (value !== undefined && value < 0n) throw new ConnectError("negative status counter", Code.InvalidArgument);
  }
  if (status.cpuUsagePercent !== undefined && (!Number.isFinite(status.cpuUsagePercent) || status.cpuUsagePercent < 0 || status.cpuUsagePercent > 100)) {
    throw new ConnectError("invalid CPU percentage", Code.InvalidArgument);
  }
  return status;
}

export function createMachineRouter(store = new MachineStore(), hub: TaskHub = taskHub, intervals = { scanMs: 5000, heartbeatMs: 15000 }) {
  const authenticate = (context: HandlerContext) => {
    const machine = store.authenticate(context.requestHeader.get("authorization"));
    if (context.method.name !== "ReportTask" && store.isUninstalled(machine.id, machine.bindingEpoch)) {
      throw new ConnectError("MACHINE_UNINSTALLED", Code.FailedPrecondition);
    }
    return machine;
  };
  const router = createConnectRouter({
    grpc: false, grpcWeb: false, readMaxBytes: 1024 * 1024, writeMaxBytes: 4 * 1024 * 1024,
    requestGate: (context) => { authenticate(context); },
  });
  router.service(MachineService, {
    async *watchTasks(request, context) {
      if (request.protocolVersion !== 1) throw new ConnectError("unsupported protocol version", Code.FailedPrecondition);
      if (!request.daemonVersion || request.daemonVersion.length > 128 || request.os.length > 32 || request.arch.length > 32 || request.supportedTasks.length > 32) {
        throw new ConnectError("invalid daemon information", Code.InvalidArgument);
      }
      const authenticated = authenticate(context);
      const bound = store.bind(authenticated.id, request.installation, request);
      const subscription = hub.open(bound.id);
      context.responseHeader.set("Cache-Control", "no-store");
      let announced = "";
      let lastHeartbeat = Date.now();
      try {
        yield { event: { case: "session" as const, value: {
          machineId: bound.id, bindingEpoch: BigInt(bound.bindingEpoch), sessionEpoch: BigInt(bound.sessionEpoch),
          heartbeatSeconds: Math.ceil(intervals.heartbeatMs / 1000), statusIntervalSeconds: 10,
        } } };
        while (!context.signal.aborted) {
          subscription.controller.signal.throwIfAborted();
          const current = authenticate(context);
          if (current.sessionEpoch !== bound.sessionEpoch || current.bindingEpoch !== bound.bindingEpoch) throw new ConnectError("STALE_SESSION", Code.Canceled);
          // Register the subscription before querying; the database is always the source of truth.
          const task = store.pending(bound.id, bound.bindingEpoch)[0];
          if (task && task.id !== announced) {
            announced = task.id;
            yield { event: { case: "task" as const, value: { taskId: task.id, payloadSha256: task.payloadHash, kind: task.kind as TaskKind } } };
          }
          if (Date.now() - lastHeartbeat >= intervals.heartbeatMs) {
            lastHeartbeat = Date.now();
            yield { event: { case: "heartbeat" as const, value: { serverTimeUnixMs: BigInt(lastHeartbeat) } } };
          }
          await subscription.wait(context.signal, Math.min(intervals.scanMs, intervals.heartbeatMs));
        }
      } finally { hub.release(bound.id, subscription); }
    },
    acceptTask(request, context) {
      const machine = authenticate(context);
      store.assertInstallation(machine, request.installation);
      const task = store.accept(machine, request.sessionEpoch, request.taskId, request.payloadSha256);
      return { taskId: task.id, bindingEpoch: BigInt(task.bindingEpoch), kind: task.kind as TaskKind, payload: task.payload, payloadSha256: task.payloadHash };
    },
    reportStatus(request, context) {
      const machine = authenticate(context);
      store.assertInstallation(machine, request.installation);
      return { committedSequence: BigInt(store.reportStatus(machine, request.sessionEpoch, request.sequence, validateStatus(request.status))) };
    },
    reportTask(request, context) {
      const machine = authenticate(context);
      store.assertInstallation(machine, request.installation);
      if (request.progressPercent !== undefined && request.progressPercent > 100) throw new ConnectError("invalid progress", Code.InvalidArgument);
      if (request.message.length > 8192 || request.errorCode.length > 128 || request.phase.length > 128) throw new ConnectError("task field too long", Code.InvalidArgument);
      if (request.actualStatus) validateStatus(request.actualStatus);
      const result = store.reportTask(machine, request);
      hub.wake(machine.id);
      return result;
    },
    getConfig(request, context) {
      const machine = authenticate(context);
      store.assertInstallation(machine, request.installation);
      return domainCall(() => new ConfigurationStore(store.database).getConfig(machine.id, request));
    },
    reportUsage(request, context) {
      const machine = authenticate(context);
      store.assertInstallation(machine, request.installation);
      const result = domainCall(() => new UsageStore(store.database).reportUsage(machine, request));
      // Accounting is already committed. Coordinate authorization separately so
      // an unrelated node failure cannot turn a committed batch into an error.
      try { new ConfigurationStore(store.database).reconcile(); }
      catch (error) { console.error("Usage committed; policy reconciliation pending", error); }
      return result;
    },
  });
  return router;
}
