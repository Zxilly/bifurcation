import "server-only";
import { cache } from "react";
import { create } from "@bufbuild/protobuf";
import { ListApiKeysResponseSchema, ListPasskeysResponseSchema } from "@bifurcation/rpc/panel/me";
import { listApiKeys as listApiKeyRows, listPasskeys as listPasskeyRows, type Principal } from "./service";
import { toProtoApiKey, toProtoPasskey } from "../rpc/panel/mappers";

// Account reads shared by the account page and MeService. Results are
// materialized messages so pages can pass them to Client Components as-is.
export const listApiKeys = cache((principal: Principal) =>
  create(ListApiKeysResponseSchema, { apiKeys: listApiKeyRows(principal).map(toProtoApiKey) }),
);

export const listPasskeys = cache((principal: Principal) =>
  create(ListPasskeysResponseSchema, { passkeys: listPasskeyRows(principal).map(toProtoPasskey) }),
);
