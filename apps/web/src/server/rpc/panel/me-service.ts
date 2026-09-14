import "server-only";
import type { ServiceImpl } from "@connectrpc/connect";
import { MeService } from "@bifurcation/rpc/panel/me";
import { webauthnOptionsJson } from "./webauthn-json";
import {
  changePassword,
  createApiKey,
  deletePasskey,
  listApiKeys,
  listPasskeys,
  revokeApiKey,
  sessionCookie,
} from "@/server/identity/service";
import { newPasskeyOptions, newPasskeyVerify } from "@/server/identity/webauthn";
import { SubscriptionStore } from "@/server/subscription/store";
import { UsageStore } from "@/server/usage/store";
import { panelCall, requirePrincipal } from "./common";
import { authentications, grainNames, toProtoApiKey, toProtoPasskey, toProtoSubscription, toProtoUsage, toProtoUser } from "./mappers";

export const meImplementation: ServiceImpl<typeof MeService> = {
  getMe(_request, context) {
    return panelCall(() => {
      const principal = requirePrincipal(context);
      return {
        user: toProtoUser(principal.user),
        authentication: authentications[principal.authentication],
        recentAuthentication: principal.recentAuthentication,
      };
    });
  },

  getMyUsage(request, context) {
    return panelCall(() => {
      const principal = requirePrincipal(context);
      const usage = new UsageStore().query({
        start: request.start === undefined ? undefined : Number(request.start),
        end: request.end === undefined ? undefined : Number(request.end),
        grain: grainNames[request.grain],
        machineId: request.machineId,
        userId: principal.user.id,
      });
      return { usage: toProtoUsage(usage) };
    });
  },

  getSubscription(_request, context) {
    return panelCall(() => ({ subscription: toProtoSubscription(new SubscriptionStore().get(requirePrincipal(context).user.id)) }));
  },

  resetSubscriptionToken(_request, context) {
    return panelCall(() => ({ subscription: toProtoSubscription(new SubscriptionStore().resetToken(requirePrincipal(context).user.id)) }));
  },

  resetProxyCredentials(_request, context) {
    return panelCall(() => ({ subscription: toProtoSubscription(new SubscriptionStore().resetProxyCredentials(requirePrincipal(context).user.id)) }));
  },

  changePassword(request, context) {
    return panelCall(async () => {
      await changePassword(requirePrincipal(context), { password: request.password });
      context.responseHeader.set("Set-Cookie", sessionCookie(""));
      return {};
    });
  },

  listApiKeys(_request, context) {
    return panelCall(() => ({ apiKeys: listApiKeys(requirePrincipal(context)).map(toProtoApiKey) }));
  },

  createApiKey(request, context) {
    return panelCall(() => {
      const { apiKey, token } = createApiKey(requirePrincipal(context), { name: request.name });
      return { apiKey: toProtoApiKey(apiKey), token };
    });
  },

  revokeApiKey(request, context) {
    return panelCall(() => {
      revokeApiKey(requirePrincipal(context), request.id);
      return {};
    });
  },

  listPasskeys(_request, context) {
    return panelCall(() => ({ passkeys: listPasskeys(requirePrincipal(context)).map(toProtoPasskey) }));
  },

  newPasskeyOptions(_request, context) {
    return panelCall(async () => {
      const { flowId, options } = await newPasskeyOptions(requirePrincipal(context));
      return { flowId, options: webauthnOptionsJson(options) };
    });
  },

  newPasskeyVerify(request, context) {
    return panelCall(async () => {
      const { passkey } = await newPasskeyVerify(requirePrincipal(context), {
        flowId: request.flowId,
        response: request.response,
        name: request.name || undefined,
      });
      return { passkey: toProtoPasskey(passkey) };
    });
  },

  deletePasskey(request, context) {
    return panelCall(() => {
      deletePasskey(requirePrincipal(context), request.id);
      return {};
    });
  },
};
