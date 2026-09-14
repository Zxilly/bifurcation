import "server-only";
import type { ServiceImpl } from "@connectrpc/connect";
import { AuthService, PasskeyPurpose } from "@bifurcation/rpc/panel/auth";
import { webauthnOptionsJson } from "./webauthn-json";
import { logout, passwordLogin, reauthenticatePassword, sessionCookie } from "@/server/identity/service";
import {
  authenticationOptions,
  authenticationVerify,
  onboardingComplete,
  onboardingOptions,
} from "@/server/identity/webauthn";
import { optionalPrincipal, panelCall, requirePrincipal } from "./common";
import { toProtoUser } from "./mappers";

const purposes: Record<PasskeyPurpose, "login" | "reauth"> = {
  [PasskeyPurpose.UNSPECIFIED]: "login",
  [PasskeyPurpose.LOGIN]: "login",
  [PasskeyPurpose.REAUTH]: "reauth",
};

export const authImplementation: ServiceImpl<typeof AuthService> = {
  passwordLogin(request, context) {
    return panelCall(async () => {
      const { user, token } = await passwordLogin({ username: request.username, password: request.password });
      context.responseHeader.set("Set-Cookie", sessionCookie(token));
      return { user: toProtoUser(user) };
    });
  },

  logout(_request, context) {
    return panelCall(() => {
      logout(requirePrincipal(context));
      context.responseHeader.set("Set-Cookie", sessionCookie(""));
      return {};
    });
  },

  passkeyOptions(request, context) {
    return panelCall(async () => {
      const purpose = purposes[request.purpose] ?? "login";
      const { flowId, options } = await authenticationOptions(
        { purpose },
        purpose === "reauth" ? optionalPrincipal(context) : undefined,
      );
      return { flowId, options: webauthnOptionsJson(options) };
    });
  },

  passkeyVerify(request, context) {
    return panelCall(async () => {
      const result = await authenticationVerify(
        {
          flowId: request.flowId,
          response: request.response,
          name: request.name || undefined,
        },
        optionalPrincipal(context),
      );
      if ("token" in result && result.token) {
        context.responseHeader.set("Set-Cookie", sessionCookie(result.token));
      }
      return { user: toProtoUser(result.user) };
    });
  },

  activationOptions(request) {
    return panelCall(async () => {
      const { flowId, username, options } = await onboardingOptions("activation", { token: request.token });
      return { flowId, username, options: webauthnOptionsJson(options) };
    });
  },

  activationComplete(request, context) {
    return panelCall(async () => {
      const { user, token } = await onboardingComplete("activation", {
        token: request.token,
        flowId: request.flowId,
        response: request.response,
        name: request.name || undefined,
        password: request.password,
      });
      context.responseHeader.set("Set-Cookie", sessionCookie(token));
      return { user: toProtoUser(user) };
    });
  },

  recoveryOptions(request) {
    return panelCall(async () => {
      const { flowId, username, options } = await onboardingOptions("recovery", { token: request.token });
      return { flowId, username, options: webauthnOptionsJson(options) };
    });
  },

  recoveryComplete(request, context) {
    return panelCall(async () => {
      const { user, token } = await onboardingComplete("recovery", {
        token: request.token,
        flowId: request.flowId,
        response: request.response,
        name: request.name || undefined,
        password: request.password,
      });
      context.responseHeader.set("Set-Cookie", sessionCookie(token));
      return { user: toProtoUser(user) };
    });
  },

  reauthPassword(request, context) {
    return panelCall(async () => {
      await reauthenticatePassword(requirePrincipal(context), { password: request.password });
      return {};
    });
  },
};
