import "server-only";
import type { ServiceImpl } from "@connectrpc/connect";
import { MeService } from "@bifurcation/rpc/panel/me";
import { webauthnOptionsJson } from "./webauthn-json";
import {
  changePassword,
  createApiKey,
  deletePasskey,
  revokeApiKey,
  sessionCookie,
} from "@/server/identity/service";
import { newPasskeyOptions, newPasskeyVerify } from "@/server/identity/webauthn";
import { SubscriptionProfileStore } from "@/server/subscription/profiles";
import { draftSchema } from "@/server/subscription/template";
import { SubscriptionStore } from "@/server/subscription/store";
import { getMyUsage } from "@/server/usage/queries";
import { listApiKeys, listPasskeys } from "@/server/identity/account-queries";
import { getSubscriptionProfile, listSubscriptionProfiles } from "@/server/subscription/queries";
import { panelCall, requirePrincipal } from "./common";
import { authentications, grainNames, toProtoApiKey, toProtoPasskey, toProtoSubscription, toProtoUser } from "./mappers";

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
    return panelCall(() => ({
      usage: getMyUsage(requirePrincipal(context), {
        start: request.start === undefined ? undefined : Number(request.start),
        end: request.end === undefined ? undefined : Number(request.end),
        grain: grainNames[request.grain],
        machineId: request.machineId,
      }),
    }));
  },

  listSubscriptionProfiles(_request, context) {
    return panelCall(() => listSubscriptionProfiles(requirePrincipal(context)));
  },
  getSubscriptionProfile(request, context) {
    return panelCall(() => ({ profile: getSubscriptionProfile(requirePrincipal(context), request.id) }));
  },
  createSubscriptionProfile(request, context) {
    return panelCall(() => ({ profile: new SubscriptionProfileStore().create(requirePrincipal(context).user.id, request) }));
  },
  saveSubscriptionDraft(request, context) {
    return panelCall(() => ({ profile: new SubscriptionProfileStore().save(requirePrincipal(context).user.id, request.id, request.expectedVersion, request.name, draftSchema.parse(request.draft)) }));
  },
  previewSubscriptionProfile(request, context) {
    return panelCall(() => new SubscriptionProfileStore().preview(requirePrincipal(context).user.id, request.id, request.expectedVersion));
  },
  publishSubscriptionProfile(request, context) {
    return panelCall(() => ({ profile: new SubscriptionProfileStore().publish(requirePrincipal(context).user.id, request.id, request.expectedVersion, request.previewId) }));
  },
  updateSubscriptionProfile(request, context) {
    return panelCall(() => ({ profile: new SubscriptionProfileStore().update(requirePrincipal(context).user.id, request.id, request.expectedVersion, request.action) }));
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
    return panelCall(() => listApiKeys(requirePrincipal(context)));
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
    return panelCall(() => listPasskeys(requirePrincipal(context)));
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
