import "server-only";
import { randomUUID } from "node:crypto";
import { Code, ConnectError, createContextKey, type HandlerContext } from "@connectrpc/connect";
import { ZodError } from "zod";
import { ErrorDetailSchema } from "@bifurcation/rpc/panel/types";
import { authenticate, requireAdmin, requireRecentSession, type Principal } from "@/server/identity/service";
import { AppError } from "@/server/http/errors";
import { getEnvironment } from "@/server/runtime/env";

export const principalKey = createContextKey<Principal | undefined>(undefined, {
  description: "Authenticated panel principal",
});

type Tier = "public" | "authenticated" | "recent" | "admin";

const service = (name: string, tiers: Record<string, Tier>) =>
  Object.fromEntries(Object.entries(tiers).map(([method, tier]) => [`bifurcation.panel.v1.${name}.${method}`, tier]));

// Every RPC has an explicit authorization tier; a missing entry fails closed.
const tiers: Record<string, Tier> = {
  ...service("AuthService", {
    PasswordLogin: "public",
    Logout: "authenticated",
    PasskeyOptions: "public",
    PasskeyVerify: "public",
    ActivationOptions: "public",
    ActivationComplete: "public",
    RecoveryOptions: "public",
    RecoveryComplete: "public",
    ReauthPassword: "authenticated",
  }),
  ...service("MeService", {
    GetMe: "authenticated",
    GetMyUsage: "authenticated",
    GetSubscription: "authenticated",
    ResetSubscriptionToken: "authenticated",
    ResetProxyCredentials: "authenticated",
    ChangePassword: "recent",
    ListApiKeys: "authenticated",
    CreateApiKey: "authenticated",
    RevokeApiKey: "authenticated",
    ListPasskeys: "authenticated",
    NewPasskeyOptions: "recent",
    NewPasskeyVerify: "recent",
    DeletePasskey: "recent",
  }),
  ...service("AdminMachineService", {
    ListMachines: "admin",
    CreateMachine: "admin",
    GetMachine: "admin",
    UpdateMachine: "admin",
    DeleteMachine: "admin",
    ResetMachineToken: "admin",
    RebindMachine: "admin",
    UninstallMachine: "admin",
    ListMachineTasks: "admin",
    EnqueueInspectTask: "admin",
    GetMachineUpgrades: "admin",
    EnqueueUpgrade: "admin",
  }),
  ...service("AdminConfigurationService", {
    GetMachineConfiguration: "admin",
    PreviewConfiguration: "admin",
    PublishConfiguration: "admin",
  }),
  ...service("AdminUserService", {
    ListUsers: "admin",
    CreateUser: "admin",
    UpdateUser: "admin",
    CreateUserFlow: "admin",
  }),
  ...service("UsageService", { QueryUsage: "admin" }),
};

const codes: Record<number, Code> = {
  400: Code.InvalidArgument,
  401: Code.Unauthenticated,
  403: Code.PermissionDenied,
  404: Code.NotFound,
  409: Code.FailedPrecondition,
  413: Code.ResourceExhausted,
  415: Code.InvalidArgument,
  422: Code.InvalidArgument,
  429: Code.ResourceExhausted,
};

function detail(code: string, requestId: string, fields?: Record<string, string[]>) {
  return {
    desc: ErrorDetailSchema,
    value: {
      code,
      requestId,
      fields: Object.fromEntries(
        Object.entries(fields ?? {}).map(([key, messages]) => [key, { messages }]),
      ),
    },
  };
}

// AppError/ZodError keep their machine-readable code inside ErrorDetail;
// the Connect code only groups the failure class.
export function toConnectError(error: unknown): ConnectError {
  const requestId = randomUUID();
  if (error instanceof ConnectError) return error;
  if (error instanceof ZodError) {
    return new ConnectError("输入数据无效", Code.InvalidArgument, undefined, [
      detail("VALIDATION_ERROR", requestId, error.flatten().fieldErrors as Record<string, string[]>),
    ]);
  }
  if (error instanceof AppError) {
    return new ConnectError(error.message, codes[error.status] ?? Code.Internal, undefined, [
      detail(error.code, requestId),
    ]);
  }
  console.error("Request failed", { requestId, error });
  return new ConnectError("服务器内部错误，请稍后重试。", Code.Internal, undefined, [
    detail("INTERNAL_ERROR", requestId),
  ]);
}

// Authenticates every panel RPC before its body is parsed, mirroring the
// REST envelope: origin check for cookie callers, no Bearer on public flows.
export function panelGate(context: HandlerContext) {
  try {
    const tier = tiers[`${context.service.typeName}.${context.method.name}`];
    if (!tier) throw new AppError("INTERNAL_ERROR", "授权配置缺失", 500);
    if (!context.requestHeader.has("authorization") && context.requestHeader.get("origin") !== getEnvironment().publicUrl) {
      throw new AppError("INVALID_ORIGIN", "请求来源无效", 403);
    }
    if (tier === "public") {
      // Anonymous authentication endpoints never accept a Bearer bypass for CSRF.
      if (context.requestHeader.has("authorization")) throw new AppError("INVALID_AUTHORIZATION", "此入口不接受 API Key", 400);
      return;
    }
    const principal = authenticate(context.requestHeader);
    if (tier === "admin") requireAdmin(principal);
    if (tier === "recent") requireRecentSession(principal);
    context.values.set(principalKey, principal);
  } catch (error) {
    throw toConnectError(error);
  }
}

export function requirePrincipal(context: HandlerContext): Principal {
  const principal = context.values.get(principalKey);
  if (!principal) throw toConnectError(new AppError("UNAUTHENTICATED", "请先登录", 401));
  return principal;
}

// Public flows may still read an existing session (passkey reauth).
export function optionalPrincipal(context: HandlerContext): Principal | undefined {
  try {
    return authenticate(context.requestHeader);
  } catch (error) {
    if (error instanceof AppError && error.status === 401) return undefined;
    throw toConnectError(error);
  }
}

// Wraps an implementation so domain failures surface as ConnectError with
// ErrorDetail instead of an opaque internal error.
export async function panelCall<T>(action: () => T | Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw toConnectError(error);
  }
}
