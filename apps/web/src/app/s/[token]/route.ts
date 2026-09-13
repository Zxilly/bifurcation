import { SubscriptionStore } from "@/server/subscription/store";
import { errorResponse } from "@/server/http/errors";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> },
) {
  try {
    return new Response(
      new SubscriptionStore().byToken((await context.params).token),
      {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
