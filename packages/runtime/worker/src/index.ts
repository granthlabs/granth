/**
 * granth-runtime-worker — the default runtime.
 *
 * Runs SQL in a dedicated Worker owned by exactly one tab, elected via Web Locks
 * by `opfs-leader`. Every other tab routes its calls to that tab. This is the
 * only runtime that can use OPFS, because sync access handles are
 * dedicated-worker-only, and it is the one that keeps SQL off the main thread.
 */

import { createLeaderClient } from 'opfs-leader';
import type { LeaderClient } from 'opfs-leader';
import type { RuntimeConnection, RuntimeConnectOptions, RuntimePlugin } from 'granth-protocol';

export interface WorkerRuntimeOptions {
  /** Called ONLY in the tab that wins the election. */
  worker: () => Worker;
  /** How long to wait for a leader before failing. Default 5000. */
  timeoutMs?: number;
  /** Test seam. */
  locks?: LockManager;
}

export function workerRuntime({ worker, timeoutMs, locks }: WorkerRuntimeOptions): RuntimePlugin {
  return {
    name: 'worker',

    /**
     * Checks only what THIS runtime needs. The Worker itself comes from a
     * caller-supplied factory, so requiring a global `Worker` constructor would
     * reject legitimate polyfills and test doubles. A factory that cannot build a
     * worker (strict CSP, for instance) surfaces as a real error from opfs-leader
     * rather than silently moving SQL onto the main thread behind your back.
     */
    isAvailable: () =>
      typeof globalThis.BroadcastChannel === 'function' &&
      (typeof locks?.request === 'function' ||
        typeof globalThis.navigator?.locks?.request === 'function'),

    connect({ name, timeoutMs: t }: RuntimeConnectOptions): RuntimeConnection {
      const leadershipListeners = new Set<(isLeader: boolean) => void>();
      const client: LeaderClient = createLeaderClient({
        name: `granth:${name}`,
        worker,
        onLeadership: (isLeader: boolean) => { for (const fn of leadershipListeners) fn(isLeader); },
        ...(timeoutMs ?? t ? { timeoutMs: timeoutMs ?? t } : {}),
        ...(locks ? { locks } : {}),
      });

      const channel = new BroadcastChannel(`granth-changes:${name}`);
      const listeners = new Set<(tables: string[]) => void>();
      channel.addEventListener('message', (e: MessageEvent) => {
        const tables = (e.data as { tables?: string[] })?.tables ?? [];
        for (const fn of listeners) fn(tables);
      });

      const effectiveLocks = locks ?? globalThis.navigator?.locks;

      return {
        call: (method, ...args) => client.call(method, ...args),

        onLeadershipChange(fn) {
          leadershipListeners.add(fn);
          return () => leadershipListeners.delete(fn);
        },

        close() {
          client.close();
          listeners.clear();
          channel.close();
        },

        onRemoteChange(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },

        broadcastChange(tables) {
          channel.postMessage({ tables });
        },

        async withLock(mode, fn) {
          if (!effectiveLocks?.request) return fn();
          return effectiveLocks.request(`granth-tx:${name}`, { mode }, fn) as Promise<
            ReturnType<typeof fn>
          >;
        },
      };
    },
  };
}

export { createLeaderClient };
export type { LeaderClient };
