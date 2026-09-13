import type { ApiErrorBody } from "@/contracts/identity";
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public requestId?: string,
  ) {
    super(message);
  }
}
export async function api<T = Record<string, never>>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers:
      options.body === undefined
        ? undefined
        : { "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (body as ApiErrorBody | null)?.error;
    throw new ApiError(
      error?.code ?? "request_failed",
      error?.message ?? `请求失败（${response.status}），请重试。`,
      error?.requestId,
    );
  }
  return body as T;
}
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "NotAllowedError")
      return "Passkey 操作已取消或超时，请重试。";
    if (error.name === "TypeError") return "无法连接服务器，请检查网络后重试。";
    return error.message;
  }
  return "操作失败，请重试。";
}
export function date(value: number | null): string {
  return value
    ? new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        timeZone: "Asia/Shanghai",
      }).format(value)
    : "尚未使用";
}
