export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public requestId?: string,
    public fields?: Record<string, string[]>,
  ) {
    super(message);
  }
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
export function date(value: number | bigint | null | undefined): string {
  return value != null
    ? new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        timeZone: "Asia/Shanghai",
      }).format(Number(value))
    : "尚未使用";
}
