import { randomUUID } from "node:crypto";
import { ZodError } from "zod";

export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export function errorResponse(error: unknown) {
  const requestId = randomUUID();
  if (error instanceof ZodError) return Response.json({ error: { code: "VALIDATION_ERROR", message: "请检查输入内容", requestId, fields: error.flatten().fieldErrors } }, { status: 422 });
  if (error instanceof AppError) return Response.json({ error: { code: error.code, message: error.message, requestId } }, { status: error.status });
  console.error("Request failed", { requestId, error });
  return Response.json({ error: { code: "INTERNAL_ERROR", message: "操作失败，请稍后重试", requestId } }, { status: 500 });
}
