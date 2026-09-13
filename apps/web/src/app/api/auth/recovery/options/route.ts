import { onboardingOptions } from "@/server/identity/webauthn";
import { readJson, withPublicApi } from "@/server/http/route";
export const POST = (request: Request) =>
  withPublicApi(request, async () =>
    onboardingOptions("recovery", await readJson(request)),
  );
