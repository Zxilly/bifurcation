import { z } from "zod";
import { readJson, withApi } from "@/server/http/route";
import { MachineStore } from "@/server/modules/machines/store";
import { taskHub } from "@/server/rpc/task-hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ machineId: string }> };

export function GET(request: Request, context: Context) {
  return withApi(
    request,
    async () => ({
      machine: new MachineStore().detail((await context.params).machineId),
    }),
    { admin: true },
  );
}

export function PATCH(request: Request, context: Context) {
  return withApi(
    request,
    async () => {
      const input = z
        .object({
          expectedVersion: z.number().int().positive(),
          name: z.string().trim().min(1).max(80).optional(),
          address: z
            .string()
            .trim()
            .min(1)
            .max(253)
            .regex(/^[a-zA-Z0-9.:[\]-]+$/)
            .optional(),
          region: z.string().trim().max(80).optional(),
        })
        .strict()
        .parse(await readJson(request));
      return {
        machine: new MachineStore().update(
          (await context.params).machineId,
          input,
        ),
      };
    },
    { admin: true },
  );
}

export function DELETE(request: Request, context: Context) {
  return withApi(
    request,
    async () => {
      const { machineId } = await context.params;
      new MachineStore().remove(machineId);
      taskHub.close(machineId);
      return { removed: true, localUninstallConfirmed: false };
    },
    { admin: true },
  );
}
