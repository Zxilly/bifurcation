import { createMachineRouter } from "@/server/rpc/machine-service";
import { handleConnectRequest } from "@/server/rpc/web-adapter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleConnectRequest(createMachineRouter(), request);
}
