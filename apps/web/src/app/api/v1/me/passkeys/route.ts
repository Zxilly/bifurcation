import { listPasskeys } from "@/server/identity/service";
import { withApi } from "@/server/http/route";
export const GET = (request: Request) =>
  withApi(request, (principal) => ({ passkeys: listPasskeys(principal) }));
