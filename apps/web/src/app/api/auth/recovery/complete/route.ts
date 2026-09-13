import { onboardingComplete } from "@/server/identity/webauthn";
import { sessionCookie } from "@/server/identity/service";
import { readJson, withPublicApi } from "@/server/http/route";
export const POST = (request: Request) =>
  withPublicApi(request, async () => {
    const { user, token } = await onboardingComplete(
      "recovery",
      await readJson(request),
    );
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
