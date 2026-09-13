import { changePassword, sessionCookie } from "@/server/identity/service";
import { readJson, withApi } from "@/server/http/route";
export const POST = (request: Request) =>
  withApi(
    request,
    async (principal) => {
      await changePassword(principal, await readJson(request));
      return Response.json(
        { ok: true },
        { headers: { "Set-Cookie": sessionCookie("") } },
      );
    },
    { recent: true },
  );
