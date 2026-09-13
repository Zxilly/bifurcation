import { withApi } from "@/server/http/route";
import { MachineStore } from "@/server/modules/machines/store";
import { taskHub } from "@/server/rpc/task-hub";

export const runtime = "nodejs";
type Context = { params: Promise<{ machineId: string }> };

export function POST(request: Request, context: Context) {
  return withApi(
    request,
    async () => {
      const { machineId } = await context.params;
      const store = new MachineStore();
      store.resetToken(machineId);
      taskHub.close(machineId);
      return { machine: store.detail(machineId) };
    },
    { admin: true },
  );
}
