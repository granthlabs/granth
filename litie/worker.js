// Worker side. This file runs in the dedicated worker that opfs-leader elects,
// so it is the ONLY thing in the origin holding the database open.
//
// Uses the sqlite3 oo1 API directly, NOT Worker1/Promiser1 — those were
// deprecated 2026-04-15 and are explicitly not being extended.

import { serveInWorker } from 'opfs-leader/worker';
import { createEngine, rpcHandlers, WRITES } from './engine.js';
import { openIdbBackedDb } from './idb-storage.js';

/** Adapt sqlite-wasm's oo1 DB to the {all, run, exec} the engine expects. */
export function sqliteWasmAdapter(sqlite3, db) {
  return {
    all: (sql, params = []) => db.selectObjects(sql, params),
    exec: (sql) => db.exec(sql),
    run(sql, params = []) {
      db.exec({ sql, bind: params });
      return {
        changes: db.changes(),
        lastInsertRowid: sqlite3.capi.sqlite3_last_insert_rowid(db),
      };
    },
  };
}

/**
 * Open the best storage available.
 * 'auto' prefers OPFS and falls back to IndexedDB, because Safari private
 * browsing has no OPFS at all — without the fallback the app simply throws there.
 */
async function openStorage(sqlite3, { filename, storage, idbName, debounceMs }) {
  if (storage !== 'indexeddb') {
    try {
      // opfs-sahpool: highest OPFS performance and — the reason it is the only
      // realistic choice — needs no COOP/COEP cross-origin isolation headers.
      // Its cost is a single connection, which is exactly what opfs-leader guarantees.
      const pool = await sqlite3.installOpfsSAHPoolVfs({ name: `litie${filename.replace(/\W/g, '')}` });
      const db = new pool.OpfsSAHPoolDb(filename);
      return {
        kind: 'opfs',
        db,
        pool,
        markDirty() {},
        async flush() {},
        async destroy() { db.close(); pool.unlink(filename); },
      };
    } catch (err) {
      if (storage === 'opfs') throw err;
      // eslint-disable-next-line no-console
      console.warn(`litie: OPFS unavailable (${err?.message ?? err}); falling back to IndexedDB.`);
    }
  }
  return openIdbBackedDb(sqlite3, { dbName: idbName ?? `litie${filename.replace(/\W/g, '')}`, key: filename, debounceMs });
}

/**
 * @param {object}   opts
 * @param {Function} opts.sqlite3InitModule  from '@sqlite.org/sqlite-wasm'
 * @param {string}   [opts.filename]  OPFS path / IndexedDB key. Default /litie.sqlite3
 * @param {'auto'|'opfs'|'indexeddb'} [opts.storage]  Default 'auto'.
 * @param {object}   [opts.upgrades]  { [version]: (engine) => void }
 * @param {object}   [opts.pragmas]
 */
export function startLitieWorker({
  sqlite3InitModule,
  filename = '/litie.sqlite3',
  storage = 'auto',
  upgrades = {},
  pragmas = {},
  idbName,
  checkpointMs = 250,
  scope = self,
}) {
  let sqlite3;
  let store;
  let engine;

  // NOT awaited before serveInWorker: the message listener must be installed
  // synchronously or calls arriving during setup are lost. serveInWorker queues
  // them behind `ready`, and a setup failure rejects them with a real error.
  const ready = (async () => {
    sqlite3 = await sqlite3InitModule();
    store = await openStorage(sqlite3, { filename, storage, idbName, debounceMs: checkpointMs });
    store.db.exec(`PRAGMA foreign_keys = ON`);
    for (const [k, v] of Object.entries(pragmas)) store.db.exec(`PRAGMA ${k} = ${v}`);
    engine = createEngine(sqliteWasmAdapter(sqlite3, store.db));
  })();

  const base = rpcHandlers(() => engine, {
    onMigrated: (result, eng) => {
      for (let v = result.from + 1; v <= result.version; v++) upgrades[v]?.(eng);
    },
  });

  // Any write marks the snapshot dirty. On OPFS this is a no-op; on the IndexedDB
  // fallback it schedules a debounced checkpoint.
  const handlers = Object.fromEntries(
    Object.entries(base).map(([name, fn]) => [
      name,
      WRITES.has(name) || name === 'open' || name === 'txCommit'
        ? (...args) => { const out = fn(...args); store.markDirty(); return out; }
        : fn,
    ])
  );

  serveInWorker(
    {
      ...handlers,

      /** Which backend actually got used — surfaced so apps can warn about durability. */
      storageKind: () => store.kind,
      flush: () => store.flush(),

      async deleteDatabase() {
        await store.destroy();
        store = await openStorage(sqlite3, { filename, storage, idbName, debounceMs: checkpointMs });
        engine = createEngine(sqliteWasmAdapter(sqlite3, store.db));
        return true;
      },

      /** Bytes on disk — OPFS quota is shared per origin, so this is worth surfacing. */
      size: () => store.db.selectValue('PRAGMA page_count') * store.db.selectValue('PRAGMA page_size'),
    },
    { scope, ready }
  );

  return ready;
}

/** Back-compat alias from the pre-1.0 `litie` name. */

/** Neutral alias, for code that prefers a generic name. */
export { startLitieWorker as startDatabaseWorker };
