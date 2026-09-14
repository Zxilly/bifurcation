import "server-only";
import { cache } from "react";
import { create } from "@bufbuild/protobuf";
import { ListUsersResponseSchema } from "@bifurcation/rpc/panel/users";
import { listUsers as listUserRows } from "./service";
import type { Principal } from "../identity/service";
import { toProtoUser } from "../rpc/panel/mappers";

// Administrator read shared by the users page and AdminUserService.
export const listUsers = cache((principal: Principal) =>
  create(ListUsersResponseSchema, { users: listUserRows(principal).map(toProtoUser) }),
);
