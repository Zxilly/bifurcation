import type { APIRequestContext } from "@playwright/test";

// Connect-protocol (JSON) unary caller for e2e setup and assertions. The
// session cookie from the page context is sent automatically; pass an
// Authorization header explicitly for API-key calls.
export async function rpc<T = Record<string, never>>(
  request: APIRequestContext,
  origin: string,
  method: string,
  data: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T }> {
  const response = await request.post(`${origin}/rpc/${method}`, {
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      ...headers,
    },
    data,
  });
  return { status: response.status(), body: (await response.json()) as T };
}
