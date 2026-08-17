/**
 * @granth/runtime-inline — run the database on the calling thread. No Worker.
 *
 * For environments where a dedicated Worker is unavailable or unwanted:
 * strict CSP without `worker-src`, some extension and embedded contexts,
 * server-side rendering with an in-memory database, unit tests, and Node.
 *
 * The trade-off is real and not hidden: SQL runs on the calling thread, so a
 * slow query blocks rendering. It also **cannot use OPFS** — sync access handles
 * are dedicated-worker-only — so pair it with the IndexedDB or memory storage
 * plugin. Prefer the worker runtime whenever a Worker exists.
 */

import type {
  RuntimeConnection,
  RuntimeConnectOptions,
  RuntimePlugin,
} from '@granth/protocol';

export interface InlineRuntimeOptions {
  /**
   * Builds the handler map. Receives nothing and returns the same RPC surface a
   * worker would serve, so the client cannot tell the difference.
   */
  createHandlers: () => Promise<Record<string, (...args: never[]) => unknown>>;
}

/**
 * Cross-tab change notification still works without a Worker — BroadcastChannel
 * is available on the main thread. Only the *execution* moves, not the topology.
 */
function makeChannel(name: string): BroadcastChannel | null {
  return typeof BroadcastChannel === 'function' ? new BroadcastChannel(`granth-changes:${name}`) : null;
}

export function inlineRuntime({ createHandlers }: InlineRuntimeOptions): RuntimePlugin {
  return {
    name: 'inline',
    // Always available: no Worker, no Web Locks, no secure context required.
    isAvailable: () => true,

    connect({ name }: RuntimeConnectOptions): RuntimeConnection {
      let handlers: Record<string, (...args: never[]) => unknown> | null = null;
      const ready = createHandlers().then((h) => {
        handlers = h;
      });

      const channel = makeChannel(name);
      const listeners = new Set<(tables: string[]) => void>();
      channel?.addEventListener('message', (e: MessageEvent) => {
        const tables = (e.data as { tables?: string[] })?.tables ?? [];
        for (const fn of listeners) fn(tables);
      });

      const locks = globalThis.navigator?.locks;
      let closed = false;

      return {
        async call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
          if (closed) throw new Error('granth: runtime is closed');
          await ready;
          const fn = handlers?.[method];
          if (typeof fn !== 'function') throw new Error(`granth: no handler "${method}"`);
          return (await fn(...(args as never[]))) as T;
        },

        close() {
          closed = true;
          listeners.clear();
          channel?.close();
        },

        onRemoteChange(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },

        broadcastChange(tables) {
          channel?.postMessage({ tables });
        },

        /**
         * Web Locks when present, so multiple *inline* tabs still serialise their
         * transactions against each other. Without it there is a single context
         * and JS is single-threaded, so running inline is already exclusive.
         */
        async withLock(mode, fn) {
          if (!locks?.request) return fn();
          return locks.request(`granth-tx:${name}`, { mode }, fn) as Promise<ReturnType<typeof fn>>;
        },
      };
    },
  };
}
