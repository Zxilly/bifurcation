import { randomUUID } from "node:crypto";

type Session = {
  machineId: string;
  bindingEpoch: string;
  sessionEpoch: string;
};
type Task = { taskId: string; payloadSha256: string; kind: string };

// A protocol peer for UI tests. It reports deterministic fixture measurements;
// it does not claim to install or execute a real sing-box process.
export async function connectMachine(
  origin: string,
  token: string,
  options: {
    installation?: { installationId: string; bindingEpoch: string };
    daemonVersion?: string;
    supportedTasks?: number[];
  } = {},
) {
  const abort = new AbortController();
  const installation = options.installation ?? {
    installationId: randomUUID(),
    bindingEpoch: "0",
  };
  const url = `${origin}/rpc/bifurcation.v1.MachineService`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Connect-Protocol-Version": "1",
  };
  const payload = Buffer.from(
    JSON.stringify({
      installation,
      daemonVersion: options.daemonVersion ?? "e2e-protocol-peer",
      protocolVersion: 1,
      supportedTasks: options.supportedTasks ?? [1, 3],
      os: "linux",
      arch: "amd64",
    }),
  );
  const envelope = Buffer.alloc(5 + payload.length);
  envelope.writeUInt32BE(payload.length, 1);
  payload.copy(envelope, 5);
  const response = await fetch(`${url}/WatchTasks`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/connect+json" },
    body: envelope,
    signal: abort.signal,
  });
  if (!response.ok || !response.body) {
    abort.abort();
    throw new Error(`Fixture WatchTasks returned ${response.status}`);
  }
  const reader = response.body.getReader();
  let buffered: Buffer = Buffer.alloc(0);
  async function event(): Promise<{ session?: Session; task?: Task }> {
    while (true) {
      if (
        buffered.length >= 5 &&
        buffered.length >= 5 + buffered.readUInt32BE(1)
      ) {
        const length = buffered.readUInt32BE(1);
        const flags = buffered[0];
        const value = JSON.parse(
          buffered.subarray(5, 5 + length).toString("utf8"),
        );
        buffered = buffered.subarray(5 + length);
        if (flags !== 0)
          throw new Error("Fixture machine stream ended before expected event");
        return value;
      }
      const next = await reader.read();
      if (next.done) throw new Error("Fixture machine stream closed");
      buffered = Buffer.concat([buffered, next.value]);
    }
  }
  const opened = await event();
  if (!opened.session) {
    abort.abort();
    throw new Error("Fixture machine did not receive its session");
  }
  const session = opened.session;
  installation.bindingEpoch = session.bindingEpoch;
  async function call<T extends object>(
    method: string,
    body: object,
  ): Promise<T> {
    const result = await fetch(`${url}/${method}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ installation, ...body }),
    });
    if (!result.ok) {
      const error = (await result.json().catch(() => null)) as {
        code?: string;
        message?: string;
      } | null;
      throw new Error(
        `Fixture ${method} returned ${result.status} (${error?.code ?? "unknown"}): ${error?.message ?? "no detail"}`,
      );
    }
    return result.json() as Promise<T>;
  }
  return {
    installation,
    session,
    call,
    async nextTask(taskId?: string) {
      while (true) {
        const next = await event();
        if (next.task && (!taskId || next.task.taskId === taskId))
          return next.task;
      }
    },
    async close() {
      abort.abort();
      await reader.cancel().catch(() => {});
    },
  };
}
