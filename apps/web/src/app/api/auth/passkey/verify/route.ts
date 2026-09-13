import { authenticate, sessionCookie } from "@/server/identity/service";
import { authenticationVerify } from "@/server/identity/webauthn";
import { readJson, withPublicApi } from "@/server/http/route";
import { AppError } from "@/server/http/errors";
export const POST = (request: Request) =>
  withPublicApi(request, async () => {
    let principal;
    try {
      principal = authenticate(request.headers);
    } catch (error) {
      if (!(error instanceof AppError && error.status === 401)) throw error;
    }
    const { user, token } = await authenticationVerify(
      await readJson(request),
      principal,
    );
    return Response.json(
      { user },
      {
        headers: {
          ...(token ? { "Set-Cookie": sessionCookie(token) } : {}),
          "Cache-Control": "no-store",
        },
      },
    );
  });
