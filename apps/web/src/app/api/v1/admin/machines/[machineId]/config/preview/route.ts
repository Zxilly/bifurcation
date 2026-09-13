import { readJson, withApi } from "@/server/http/route";
import { ConfigurationStore } from "@/server/configuration/store";
export const runtime = "nodejs";
export const POST = (
  request: Request,
  context: { params: Promise<{ machineId: string }> },
) =>
  withApi(
    request,
    async (principal) =>
      new ConfigurationStore().preview(
        (await context.params).machineId,
        await readJson(request),
        principal.user.id,
      ),
    { admin: true, maxBodyBytes: 4 * 1024 * 1024 },
  );
