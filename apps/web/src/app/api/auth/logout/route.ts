import { logout, sessionCookie } from "@/server/identity/service";
import { withApi } from "@/server/http/route";
export const POST = (request: Request) =>
  withApi(request, (principal) => {
    logout(principal);
    return Response.json(
      { ok: true },
      { headers: { "Set-Cookie": sessionCookie("") } },
    );
  });
