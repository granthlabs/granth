import type { WorkerReply } from './index.js';

// Worker side. Import this inside the dedicated worker that owns the resource.
//
// This worker is constructed ONLY in the elected tab, so whatever it opens
// (opfs-sahpool SQLite, an OPFS scratch file, DuckDB) has exactly one writer
// across the whole origin — which is the only thing that actually eliminated
// Notion's multi-tab corruption. Web Locks alone only made it rarer.

/**
 * @param {Record<string, Function>} handlers  method name -> implementation.
 *
 * Every handler is an RPC method and nothing else. There is deliberately no
 * magic "init" name: a handler that the library calls implicitly AND the caller
 * can invoke by name is a collision waiting to happen (it bit litie, whose
 * natural RPC name is `open`). Do setup with a plain `await` before calling this.
 */
export interface ServeScope {
  addEventListener(type: 'message', fn: (event: { data: WorkerCall }) => void): void;
  postMessage(message: WorkerReply): void;
}

/** What the leader posts to the worker for each call. */
export interface WorkerCall {
  callId: string;
  method: string;
  args?: unknown[];
}

export interface ServeOptions {
  /** Defaults to the worker's global scope. */
  scope?: ServeScope;
  /**
   * Calls are queued until this resolves, so async setup cannot drop early
   * messages. If it rejects, every call rejects with that error instead of hanging.
   */
  ready?: Promise<unknown>;
}

export type Handlers = Record<string, (...args: never[]) => unknown>;

export function serveInWorker(
  handlers: Handlers,
  { scope = self as unknown as ServeScope, ready = Promise.resolve() }: ServeOptions = {}
): void {
  // Registered SYNCHRONOUSLY. A worker module finishes evaluating while its async
  // setup is still running, so any message arriving in that window would be
  // dropped on the floor — the caller then waits forever. Queue behind `ready`
  // instead, and let a failed setup reject every call rather than hang it.
  scope.addEventListener('message', async (event) => {
    const { callId, method, args = [] } = event.data;
    try {
      await ready;
      const fn = handlers[method];
      if (typeof fn !== 'function') throw new Error(`opfs-leader: no handler "${method}"`);
      scope.postMessage({ callId, value: await fn(...(args as never[])) });
    } catch (err: unknown) {
      // Errors do not survive structured clone with their prototype — send the parts.
      scope.postMessage({
        callId,
        error: {
          message: (err as Error)?.message ?? String(err),
          name: (err as Error)?.name ?? 'Error',
        },
      });
    }
  });
}
