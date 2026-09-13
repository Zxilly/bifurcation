import { readJson, withApi } from "@/server/http/route";
import { ReleaseStore } from "@/server/releases/store";

export const runtime = "nodejs";
export const POST = (
  request: Request,
  context: { params: Promise<{ machineId: string }> },
) =>
  withApi(
    request,
    async () =>
      new ReleaseStore().uninstall(
        (await context.params).machineId,
        await readJson(request),
      ),
    { admin: true },
  );
