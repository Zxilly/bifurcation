import "server-only";
import { authenticate, requireAdmin, requireRecentSession, type Principal } from "../identity/service";
import { getEnvironment } from "../runtime/env";
import { AppError, errorResponse } from "./errors";

export function checkOrigin(request: Request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  if (request.headers.has("authorization")) return;
  if (request.headers.get("origin") !== getEnvironment().publicUrl) throw new AppError("INVALID_ORIGIN", "请求来源无效", 403);
}
const parsedBodies = new WeakMap<Request, Promise<unknown>>();
export function readJson(request: Request, maxBytes = 64 * 1024): Promise<unknown> {
  let pending = parsedBodies.get(request);
  if (!pending) { pending = parseJson(request, maxBytes); parsedBodies.set(request, pending); }
  return pending;
}
async function parseJson(request: Request, maxBytes: number): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new AppError("INVALID_CONTENT_TYPE", "需要 JSON 请求", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new AppError("INVALID_JSON", "缺少请求内容", 422);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new AppError("BODY_TOO_LARGE", "请求内容过大", 413); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new AppError("INVALID_JSON", "JSON 格式无效", 422); }
}
export async function withApi(request: Request, handler: (principal: Principal) => unknown | Promise<unknown>, options: { admin?: boolean; recent?: boolean; maxBodyBytes?: number } = {}) {
  try {
    checkOrigin(request);
    if ((options.maxBodyBytes ?? 0) > 64 * 1024) {
      const initial = authenticate(request);
      if (options.admin) requireAdmin(initial);
      if (options.recent) requireRecentSession(initial);
    }
    // Do not grant a role before waiting on an attacker-controlled request body.
    if (request.body && request.headers.get("content-type")?.startsWith("application/json")) await readJson(request, options.maxBodyBytes);
    const principal = authenticate(request);
    if (options.admin) requireAdmin(principal);
    if (options.recent) requireRecentSession(principal);
    const result = await handler(principal);
    return result instanceof Response ? result : Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
export async function withPublicApi(request: Request, handler: () => unknown | Promise<unknown>) {
  try {
    // Anonymous authentication endpoints never accept a Bearer bypass for CSRF.
    if (request.headers.has("authorization")) throw new AppError("INVALID_AUTHORIZATION", "此入口不接受 API Key", 400);
    checkOrigin(request);
    const result = await handler();
    return result instanceof Response ? result : Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
