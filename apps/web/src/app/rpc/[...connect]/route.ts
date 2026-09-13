import { createMachineRouter } from "@/server/rpc/machine-service";
import { createPanelRouter } from "@/server/rpc/panel/router";
import { handleConnectRequest } from "@/server/rpc/web-adapter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One Connect endpoint: the daemon machine stream and the panel API share
// the transport, each behind its own authentication gate.
const handlers = [...createMachineRouter().handlers, ...createPanelRouter().handlers];

export async function POST(request: Request) {
  return handleConnectRequest({ handlers }, request);
}
