import { createApiKey, listApiKeys } from "@/server/identity/service";
import { readJson, withApi } from "@/server/http/route";
export const GET = (request: Request) =>
  withApi(request, (principal) => ({ apiKeys: listApiKeys(principal) }));
export const POST = (request: Request) =>
  withApi(request, async (principal) =>
    createApiKey(principal, await readJson(request)),
  );
