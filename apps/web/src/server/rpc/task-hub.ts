import "server-only";
import { Code, ConnectError } from "@connectrpc/connect";

class TaskSubscription {
  readonly controller = new AbortController();
  private dirty = false;
  private notify?: () => void;

  wake() {
    this.dirty = true;
    this.notify?.();
  }

  async wait(signal: AbortSignal, milliseconds: number) {
    const combined = AbortSignal.any([signal, this.controller.signal]);
    combined.throwIfAborted();
    if (this.dirty) { this.dirty = false; return; }
    await new Promise<void>((resolve, reject) => {
      const finish = () => { cleanup(); this.dirty = false; resolve(); };
      const abort = () => { cleanup(); reject(combined.reason); };
      const timer = setTimeout(finish, milliseconds);
      timer.unref?.();
      const cleanup = () => {
        clearTimeout(timer);
        combined.removeEventListener("abort", abort);
        this.notify = undefined;
      };
      this.notify = finish;
      combined.addEventListener("abort", abort, { once: true });
      if (combined.aborted) abort();
    });
  }
}

export class TaskHub {
  private readonly subscriptions = new Map<string, TaskSubscription>();

  open(machineId: string): TaskSubscription {
    this.close(machineId, new ConnectError("connection replaced", Code.Canceled));
    const subscription = new TaskSubscription();
    this.subscriptions.set(machineId, subscription);
    return subscription;
  }

  wake(machineId: string) { this.subscriptions.get(machineId)?.wake(); }

  release(machineId: string, subscription: TaskSubscription) {
    if (this.subscriptions.get(machineId) === subscription) this.subscriptions.delete(machineId);
    subscription.controller.abort(new ConnectError("connection closed", Code.Canceled));
  }

  close(machineId: string, reason = new ConnectError("machine credential revoked", Code.Unauthenticated)) {
    this.subscriptions.get(machineId)?.controller.abort(reason);
    this.subscriptions.delete(machineId);
  }

  shutdown() {
    for (const id of this.subscriptions.keys()) this.close(id, new ConnectError("panel shutting down", Code.Unavailable));
  }

  get size() { return this.subscriptions.size; }
  connected(machineId: string) { return this.subscriptions.get(machineId)?.controller.signal.aborted === false; }
}

const runtime = globalThis as typeof globalThis & { bifurcationTaskHub?: TaskHub };
export const taskHub = runtime.bifurcationTaskHub ??= new TaskHub();
