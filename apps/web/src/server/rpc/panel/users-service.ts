import "server-only";
import type { ServiceImpl } from "@connectrpc/connect";
import { AdminUserService, FlowPurpose } from "@bifurcation/rpc/panel/users";
import { Role, UserStatus } from "@bifurcation/rpc/panel/types";
import { createUser, createUserFlow, updateUser } from "@/server/users/service";
import { listUsers } from "@/server/users/queries";
import { panelCall, requirePrincipal } from "./common";
import { toProtoUser } from "./mappers";

const roleNames: Record<Role, "admin" | "user" | undefined> = {
  [Role.UNSPECIFIED]: undefined,
  [Role.ADMIN]: "admin",
  [Role.USER]: "user",
};
const statusNames: Record<UserStatus, "active" | "disabled" | undefined> = {
  [UserStatus.UNSPECIFIED]: undefined,
  [UserStatus.PENDING]: undefined,
  [UserStatus.ACTIVE]: "active",
  [UserStatus.DISABLED]: "disabled",
};
const purposeNames: Record<FlowPurpose, "activation" | "recovery"> = {
  [FlowPurpose.UNSPECIFIED]: "activation",
  [FlowPurpose.ACTIVATION]: "activation",
  [FlowPurpose.RECOVERY]: "recovery",
};

export const usersImplementation: ServiceImpl<typeof AdminUserService> = {
  listUsers(_request, context) {
    return panelCall(() => listUsers(requirePrincipal(context)));
  },

  createUser(request, context) {
    return panelCall(() => {
      const { user, activationUrl } = createUser(requirePrincipal(context), {
        username: request.username,
        role: roleNames[request.role],
        monthlyLimitBytes: request.monthlyLimitBytes,
      });
      return { user: toProtoUser(user), activationUrl };
    });
  },

  updateUser(request, context) {
    return panelCall(() => {
      const { user } = updateUser(requirePrincipal(context), request.id, {
        expectedVersion: request.expectedVersion,
        role: request.role === undefined ? undefined : roleNames[request.role],
        status: request.status === undefined ? undefined : statusNames[request.status],
        monthlyLimitBytes: request.clearMonthlyLimit ? null : request.monthlyLimitBytes,
      });
      return { user: toProtoUser(user) };
    });
  },

  createUserFlow(request, context) {
    return panelCall(() => {
      const { url, expiresAt } = createUserFlow(requirePrincipal(context), request.id, purposeNames[request.purpose]);
      return { url, expiresAt: BigInt(expiresAt) };
    });
  },
};
