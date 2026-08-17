/**
 * granth-storage-opfs — the fast path.
 *
 * Uses the `opfs-sahpool` VFS: the highest-performance OPFS backend and, crucially,
 * the only one that needs no COOP/COEP cross-origin isolation headers. Its cost is
 * a single connection, which is exactly what the worker runtime's leader election
 * guarantees. Writes land in place, so there is nothing to checkpoint.
 *
 * Requires a dedicated Worker: OPFS sync access handles exist nowhere else.
 */

import type { Adapter, StorageHandle, StorageOpenOptions, StoragePlugin } from 'granth-protocol';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function sqliteWasmAdapter(sqlite3: any, db: any): Adapter {
  return {
    all: (sql: string, params: unknown[] = []) => db.selectObjects(sql, params),
    exec: (sql: string) => db.exec(sql),
    run(sql: string, params: unknown[] = []) {
      db.exec({ sql, bind: params });
      return { changes: db.changes(), lastInsertRowid: sqlite3.capi.sqlite3_last_insert_rowid(db) };
    },
  };
}

export function opfsStorage(): StoragePlugin {
  return {
    name: 'opfs',

    isAvailable(sqlite3: any) {
      // Availability is not just "is there an OPFS object": Safari private
      // browsing exposes none at all, and installing the VFS is what actually
      // proves it. The plugin list falls through to IndexedDB when this is false.
      return (
        typeof sqlite3?.installOpfsSAHPoolVfs === 'function' &&
        typeof navigator?.storage?.getDirectory === 'function'
      );
    },

    async open({ sqlite3, filename, pragmas = {} }: StorageOpenOptions): Promise<StorageHandle> {
      const s = sqlite3 as any;
      const pool = await s.installOpfsSAHPoolVfs({ name: `granth${filename.replace(/\W/g, '')}` });
      const db = new pool.OpfsSAHPoolDb(filename);
      db.exec('PRAGMA foreign_keys = ON');
      for (const [k, v] of Object.entries(pragmas)) db.exec(`PRAGMA ${k} = ${v}`);

      return {
        kind: 'opfs',
        adapter: sqliteWasmAdapter(s, db),
        markDirty() {},           // in-place writes: nothing to schedule
        async flush() {},         // and nothing to flush
        async destroy() {
          db.close();
          pool.unlink(filename);
        },
      };
    },
  };
}
