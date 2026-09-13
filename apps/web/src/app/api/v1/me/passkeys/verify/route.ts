import { newPasskeyVerify } from "@/server/identity/webauthn";
import { readJson, withApi } from "@/server/http/route";
export const POST = (request: Request) =>
  withApi(
    request,
    async (principal) => newPasskeyVerify(principal, await readJson(request)),
    { recent: true },
  );
