import { withApi } from "@/server/http/route";
export const GET = (request: Request) =>
  withApi(request, ({ user, authentication, recentAuthentication }) => ({
    user,
    authentication,
    recentAuthentication,
  }));
