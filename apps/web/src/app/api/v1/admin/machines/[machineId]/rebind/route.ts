import { z } from "zod";
import { readJson, withApi } from "@/server/http/route";
import { MachineStore } from "@/server/modules/machines/store";
import { taskHub } from "@/server/rpc/task-hub";
import { getDatabase } from "@/server/db";
import { ConfigurationStore } from "@/server/configuration/store";

export const runtime = "nodejs";
type Context = { params: Promise<{ machineId: string }> };

export function POST(request: Request, context: Context) {
  return withApi(
    request,
    async () => {
      const { expectedVersion } = z
        .object({ expectedVersion: z.number().int().positive() })
        .strict()
        .parse(await readJson(request));
      const { machineId } = await context.params;
      const handle = getDatabase();
      const machine = handle.db.transaction(() => {
        const rebound = new MachineStore(handle).rebind(
          machineId,
          expectedVersion,
        );
        new ConfigurationStore(handle).markForRebind(machineId);
        return rebound;
      });
      taskHub.close(machineId);
      return { machine };
    },
    { admin: true },
  );
}
