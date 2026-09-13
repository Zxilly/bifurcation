import { withApi } from "@/server/http/route";
import { ConfigurationStore } from "@/server/configuration/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (
  request: Request,
  context: { params: Promise<{ machineId: string }> },
) =>
  withApi(
    request,
    async () => new ConfigurationStore().get((await context.params).machineId),
    { admin: true },
  );
