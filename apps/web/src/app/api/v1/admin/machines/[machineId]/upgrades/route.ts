import { readJson, withApi } from "@/server/http/route";
import { ReleaseStore } from "@/server/releases/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ machineId: string }> };
export const GET = (request: Request, context: Context) =>
  withApi(
    request,
    async () => new ReleaseStore().get((await context.params).machineId),
    { admin: true },
  );
export const POST = (request: Request, context: Context) =>
  withApi(
    request,
    async () =>
      new ReleaseStore().enqueue(
        (await context.params).machineId,
        await readJson(request),
      ),
    { admin: true },
  );
