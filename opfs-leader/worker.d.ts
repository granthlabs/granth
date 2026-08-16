export interface ServeOptions {
  /** Defaults to the worker's global scope. */
  scope?: { addEventListener: Function; postMessage: Function };
  /**
   * Calls are queued until this resolves, so async setup cannot drop early
   * messages. If it rejects, every call rejects with that error instead of hanging.
   */
  ready?: Promise<unknown>;
}

/**
 * Serve RPC calls from the elected tab's client.
 * Every handler is an RPC method and nothing else — there is no implicit init name.
 */
export declare function serveInWorker(
  handlers: Record<string, (...args: any[]) => unknown>,
  opts?: ServeOptions
): void;
