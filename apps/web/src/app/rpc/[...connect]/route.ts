import type { ConnectRouter } from "@connectrpc/connect";
import { createMachineRouter } from "@/server/rpc/machine-service";
import { createPanelRouter } from "@/server/rpc/panel/router";
import { handleConnectRequest } from "@/server/rpc/web-adapter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One Connect endpoint: the daemon machine stream and the panel API share
// the transport, each behind its own authentication gate. Handlers are built
// lazily so module evaluation stays free of runtime environment access.
let handlers: ConnectRouter["handlers"] | undefined;
function getHandlers() {
  handlers ??= [
    ...createMachineRouter().handlers,
    ...createPanelRouter().handlers,
  ];
  return handlers;
}

export async function POST(request: Request) {
  return handleConnectRequest({ handlers: getHandlers() }, request);
}
