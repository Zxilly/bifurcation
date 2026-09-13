import { authenticate } from "@/server/identity/service";
import { authenticationOptions } from "@/server/identity/webauthn";
import { readJson, withPublicApi } from "@/server/http/route";
export const POST = (request: Request) =>
  withPublicApi(request, async () => {
    const input = await readJson(request);
    const reauth =
      typeof input === "object" &&
      input !== null &&
      "purpose" in input &&
      input.purpose === "reauth";
    return authenticationOptions(
      input,
      reauth ? authenticate(request.headers) : undefined,
    );
  });
