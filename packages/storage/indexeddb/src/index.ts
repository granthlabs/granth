/* eslint-disable @typescript-eslint/no-explicit-any */
import type { StorageHandle, StorageOpenOptions, StoragePlugin } from '@granth/protocol';
import { sqliteWasmAdapter } from '@granth/storage-opfs';

// IndexedDB fallback storage.
//
// WHY THIS EXISTS: OPFS is not universally available. Safari private browsing has
// **no OPFS at all** — not a slow path, a hard failure — and Chrome incognito caps
// an OPFS database at ~100 MB with surprising errors. Without a fallback, an app
// that works everywhere else throws the moment a user opens a private window.
//
// WHAT IT IS NOT: a second query engine. It is the SAME SQLite build running on an
// in-memory database, whose bytes are checkpointed into IndexedDB. Every query,
// index, trigger and migration behaves identically — only durability differs.
//
// ponytail: whole-file checkpoint, not page-level writes. Simple and correct, with
// a real ceiling: cost is O(database size) per checkpoint, so it suits the fallback
// case (tens of MB) and not a primary store. Upgrade path if that ever bites is a
// page-level VFS over IndexedDB (wa-sqlite's IDBBatchAtomicVFS).

const STORE = 'files';

function open(dbName: string): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error(`granth: IndexedDB "${dbName}" is blocked by another connection`));
  });
}

const tx = <T>(idb: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> =>
  new Promise<T | undefined>((resolve, reject) => {
    const t = idb.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve((out as IDBRequest<T> | undefined)?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('granth: IndexedDB transaction aborted'));
  });

export async function idbLoad(dbName: string, key: string): Promise<Uint8Array | undefined> {
  const idb = await open(dbName);
  try {
    const value = await tx<ArrayBuffer | Uint8Array>(idb, 'readonly', (s) => s.get(key) as IDBRequest<ArrayBuffer | Uint8Array>);
    return value instanceof Uint8Array ? value : value ? new Uint8Array(value) : undefined;
  } finally {
    idb.close();
  }
}

export async function idbSave(dbName: string, key: string, bytes: Uint8Array): Promise<void> {
  const idb = await open(dbName);
  try {
    await tx(idb, 'readwrite', (s) => s.put(bytes, key));
  } finally {
    idb.close();
  }
}

export async function idbRemove(dbName: string, key: string): Promise<void> {
  const idb = await open(dbName);
  try {
    await tx(idb, 'readwrite', (s) => s.delete(key));
  } finally {
    idb.close();
  }
}

/**
 * An in-memory SQLite database restored from, and checkpointed back to, IndexedDB.
 * @returns {{db: object, markDirty(): void, flush(): Promise<void>, destroy(): Promise<void>, kind: 'indexeddb'}}
 */
export async function openIdbBackedDb(
  sqlite3: any,
  { dbName, key, debounceMs = 250 }: { dbName: string; key: string; debounceMs?: number }
): Promise<StorageHandle & { db: unknown }> {
  const capi = sqlite3.capi;
  const db = new sqlite3.oo1.DB();

  const saved = await idbLoad(dbName, key);
  if (saved?.byteLength) {
    const p = sqlite3.wasm.allocFromTypedArray(saved);
    const rc = capi.sqlite3_deserialize(
      db.pointer,
      'main',
      p,
      saved.byteLength,
      saved.byteLength,
      capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE
    );
    if (rc) {
      sqlite3.wasm.dealloc(p);
      throw new Error(`granth: could not restore the IndexedDB snapshot (sqlite rc=${rc})`);
    }
  }

  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  async function persist(): Promise<void> {
    if (!dirty) return;
    dirty = false;
    const bytes = capi.sqlite3_js_db_export(db);
    await idbSave(dbName, key, bytes);
  }

  return {
    kind: 'indexeddb',
    db,
    adapter: sqliteWasmAdapter(sqlite3, db),
    markDirty() {
      dirty = true;
      clearTimeout(timer);
      // Coalesce bursts: a bulkAdd of 5k rows must not write the whole file 5k times.
      timer = setTimeout(() => { inFlight = inFlight.then(persist).catch(() => {}); }, debounceMs);
    },
    async flush() {
      clearTimeout(timer);
      inFlight = inFlight.then(persist);
      await inFlight;
    },
    async destroy() {
      clearTimeout(timer);
      dirty = false;
      await idbRemove(dbName, key);
    },
  };
}

/**
 * The fallback that keeps apps working where OPFS does not exist — most
 * importantly Safari private browsing, which exposes none at all.
 *
 * It is the SAME SQLite engine, not a second implementation: an in-memory
 * database whose bytes are checkpointed into IndexedDB. Every query, index,
 * trigger and migration behaves identically; only durability differs.
 */
export function indexeddbStorage(): StoragePlugin {
  return {
    name: 'indexeddb',
    isAvailable: () => typeof indexedDB !== 'undefined',
    open: ({ sqlite3, filename, checkpointMs }: StorageOpenOptions) =>
      openIdbBackedDb(sqlite3, {
        dbName: `granth${filename.replace(/\W/g, '')}`,
        key: filename,
        ...(checkpointMs === undefined ? {} : { debounceMs: checkpointMs }),
      }),
  };
}
