import "server-only";
import { cache } from "react";
import { create } from "@bufbuild/protobuf";
import { UsageSchema } from "@bifurcation/rpc/panel/usage";
import { requireAdmin, type Principal } from "@/server/identity/service";
import { toProtoUsage } from "@/server/rpc/panel/mappers";
import { UsageStore } from "./store";

export type UsageQuery = {
  start?: number;
  end?: number;
  grain?: "minute" | "day" | "month";
  machineId?: string;
};

// Usage reads shared by the overview pages, MeService and UsageService.
export const getMyUsage = cache((principal: Principal, query: UsageQuery) =>
  create(UsageSchema, toProtoUsage(new UsageStore().query({ ...query, userId: principal.user.id }))),
);

export const queryUsage = cache((principal: Principal, query: UsageQuery & { userId?: string }) => {
  requireAdmin(principal);
  return create(UsageSchema, toProtoUsage(new UsageStore().query(query)));
});
