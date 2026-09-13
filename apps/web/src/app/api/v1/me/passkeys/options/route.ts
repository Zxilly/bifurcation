import { newPasskeyOptions } from "@/server/identity/webauthn";
import { withApi } from "@/server/http/route";
export const POST = (request: Request) =>
  withApi(request, (principal) => newPasskeyOptions(principal), {
    recent: true,
  });
