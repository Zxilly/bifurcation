import { z } from "zod";
import { readJson, withApi } from "@/server/http/route";
import { MachineStore } from "@/server/modules/machines/store";
import { taskHub } from "@/server/rpc/task-hub";

export const runtime = "nodejs";
type Context = { params: Promise<{ machineId: string }> };
const input = z
  .object({
    kind: z.literal("inspect"),
    requestKey: z.uuid(),
    includeLogs: z.boolean().default(false),
    maxLogLines: z.number().int().min(1).max(1000).default(100),
    maxBytes: z.number().int().min(1024).max(262144).default(262144),
  })
  .strict();

export function GET(request: Request, context: Context) {
  return withApi(
    request,
    async () => ({
      tasks: new MachineStore().listTasks((await context.params).machineId),
    }),
    { admin: true },
  );
}

export function POST(request: Request, context: Context) {
  return withApi(
    request,
    async () => {
      const { machineId } = await context.params;
      const { requestKey, includeLogs, maxLogLines, maxBytes } = input.parse(
        await readJson(request),
      );
      const task = new MachineStore().enqueueInspect(machineId, requestKey, {
        includeLogs,
        maxLogLines,
        maxBytes,
      });
      taskHub.wake(machineId);
      return { task };
    },
    { admin: true },
  );
}
