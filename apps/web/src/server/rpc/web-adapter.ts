import type { ConnectRouter } from "@connectrpc/connect";

// Adapt Fetch streams to Connect's universal handlers; Connect owns framing,
// protobuf serialization and protocol errors.
export async function handleConnectRequest(router: ConnectRouter, request: Request): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const handler = router.handlers.find((candidate) => `/rpc${candidate.requestPath}` === pathname);
  if (!handler) return new Response(null, { status: 404 });
  const cancelled = new AbortController();
  const signal = AbortSignal.any([request.signal, cancelled.signal]);
  async function* requestBytes() {
    const reader = request.body?.getReader();
    if (!reader) return;
    let finished = false;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) { finished = true; return; }
        yield result.value;
      }
    } finally {
      if (!finished) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  const response = await handler({
    httpVersion: "1.1", url: request.url, method: request.method,
    header: request.headers, body: requestBytes(), signal,
  });
  const iterator = response.body?.[Symbol.asyncIterator]();
  const headers = new Headers(response.header);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Accel-Buffering", "no");
  const body = iterator ? new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        cancelled.abort(error);
        controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled.abort(reason ?? new Error("response cancelled"));
      await iterator.return?.();
    },
  }) : null;
  return new Response(body, { status: response.status, headers });
}
