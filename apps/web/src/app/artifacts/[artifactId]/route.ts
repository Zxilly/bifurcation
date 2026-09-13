import { artifactResponse } from "@/server/artifacts/download";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ artifactId: string }> };
export async function GET(_request: Request, context: Context) {
  return artifactResponse((await context.params).artifactId);
}
export async function HEAD(_request: Request, context: Context) {
  return artifactResponse((await context.params).artifactId, true);
}
