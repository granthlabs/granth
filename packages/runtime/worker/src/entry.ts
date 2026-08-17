/**
 * Worker entry point. This is what your `db.worker.js` calls.
 *
 * It composes plugins rather than hard-coding a backend: you pass an ordered
 * list of storage plugins and the first available one wins. That ordering is the
 * whole degradation story — `[opfs, indexeddb, memory]` keeps an app running in
 * Safari private browsing (no OPFS at all) instead of throwing.
 */

import { serveInWorker } from 'opfs-leader/worker';
import { createEngine, rpcHandlers } from '@granth/engine';
import type { Engine, MigrateResult } from '@granth/engine';
import type { StorageHandle, StoragePlugin } from '@granth/protocol';

export interface StartWorkerOptions {
  /** The default export of '@sqlite.org/sqlite-wasm'. */
  sqlite3InitModule: () => Promise<unknown>;
  /** OPFS path / storage key. Default '/granth.sqlite3'. */
  filename?: string;
  /** Tried in order; the first available one is used. */
  storage: StoragePlugin[];
  /** Data transforms keyed by the version being upgraded TO. */
  upgrades?: Record<number, (engine: Engine) => void>;
  pragmas?: Record<string, string | number>;
  checkpointMs?: number;
  /** Test seam. */
  scope?: Parameters<typeof serveInWorker>[1] extends { scope?: infer S } ? S : never;
}

async function pickStorage(
  plugins: StoragePlugin[],
  sqlite3: unknown,
  open: Omit<Parameters<StoragePlugin['open']>[0], 'sqlite3'>
): Promise<StorageHandle> {
  const tried: string[] = [];
  for (const plugin of plugins) {
    tried.push(plugin.name);
    if (!(await plugin.isAvailable(sqlite3))) continue;
    try {
      return await plugin.open({ ...open, sqlite3 });
    } catch (err) {
      // Availability is a prediction; opening is the proof. Keep degrading.
      // eslint-disable-next-line no-console
      console.warn(`granth: storage "${plugin.name}" failed to open (${String(err)}); trying the next.`);
    }
  }
  throw new Error(
    `granth: no storage backend could be opened. Tried: ${tried.join(', ') || '(none supplied)'}.`
  );
}

export function startGranthWorker({
  sqlite3InitModule,
  filename = '/granth.sqlite3',
  storage,
  upgrades = {},
  pragmas = {},
  checkpointMs,
  scope,
}: StartWorkerOptions): Promise<void> {
  let store: StorageHandle;
  let engine: Engine;

  // NOT awaited before serveInWorker: the message listener must be installed
  // synchronously or calls arriving during setup are lost. serveInWorker queues
  // them behind `ready`, and a setup failure rejects them with a real error.
  let sqlite3: unknown;
  const openOpts = {
    filename,
    pragmas,
    ...(checkpointMs === undefined ? {} : { checkpointMs }),
  };

  /** Open (or re-open) the store and bind a fresh engine to it. */
  const connect = async (): Promise<void> => {
    store = await pickStorage(storage, sqlite3, openOpts);
    engine = createEngine(store.adapter);
  };

  const ready = (async () => {
    sqlite3 = await sqlite3InitModule();
    await connect();
  })();

  const base = rpcHandlers(() => engine, {
    onMigrated: (result: MigrateResult, eng: Engine) => {
      for (let v = result.from + 1; v <= result.version; v++) upgrades[v]?.(eng);
    },
  });

  // Any write marks the snapshot dirty. A no-op for in-place backends like OPFS;
  // for checkpointing backends it schedules a debounced write.
  const WRITES = new Set([
    'add', 'put', 'bulkAdd', 'bulkPut', 'update', 'upsert', 'bulkUpdate',
    'delete', 'bulkDelete', 'clear', 'deleteWhere', 'modifyWhere', 'batch',
    'open', 'txCommit',
  ]);
  const handlers = Object.fromEntries(
    Object.entries(base).map(([name, fn]) => [
      name,
      WRITES.has(name)
        ? (...args: never[]) => {
            const out = (fn as (...a: never[]) => unknown)(...args);
            store.markDirty();
            return out;
          }
        : fn,
    ])
  );

  serveInWorker(
    {
      ...handlers,
      storageKind: () => store.kind,
      flush: () => store.flush(),
      async deleteDatabase() {
        // destroy() closes the underlying handle, so the store MUST be re-opened
        // or every later call fails with "DB has been closed" — which is exactly
        // what the browser suite caught.
        await store.destroy();
        await connect();
        return true;
      },
    },
    { ...(scope ? { scope } : {}), ready } as Parameters<typeof serveInWorker>[1]
  );

  return ready;
}
