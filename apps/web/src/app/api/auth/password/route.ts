import { passwordLogin, sessionCookie } from "@/server/identity/service";
import { readJson, withPublicApi } from "@/server/http/route";
export const POST = (request: Request) =>
  withPublicApi(request, async () => {
    const { user, token } = await passwordLogin(await readJson(request));
    return Response.json(
      { user },
      {
        headers: {
          "Set-Cookie": sessionCookie(token),
          "Cache-Control": "no-store",
        },
      },
    );
  });
