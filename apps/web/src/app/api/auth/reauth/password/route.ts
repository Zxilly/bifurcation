import { reauthenticatePassword } from "@/server/identity/service";
import { readJson, withApi } from "@/server/http/route";
export const POST = (request: Request) =>
  withApi(request, async (principal) =>
    reauthenticatePassword(principal, await readJson(request)),
  );
