/**
 * granth-storage-memory — an in-memory database that persists nothing.
 *
 * The point is not speed, it is that it works absolutely everywhere: Node, SSR,
 * unit tests, private browsing, sandboxed iframes with no storage access. Pair it
 * with the inline runtime for a zero-requirement setup, and use it as the last
 * entry in a storage list so the app degrades to ephemeral rather than throwing.
 */

import type { Adapter, StorageHandle, StorageOpenOptions, StoragePlugin } from 'granth-protocol';
import { sqliteWasmAdapter } from 'granth-storage-opfs';

export function memoryStorage(): StoragePlugin {
  return {
    name: 'memory',
    isAvailable: () => true,

    async open({ sqlite3, pragmas = {} }: StorageOpenOptions): Promise<StorageHandle> {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const s = sqlite3 as any;
      const db = new s.oo1.DB();
      db.exec('PRAGMA foreign_keys = ON');
      for (const [k, v] of Object.entries(pragmas)) db.exec(`PRAGMA ${k} = ${v}`);

      const adapter: Adapter = sqliteWasmAdapter(s, db);
      return {
        kind: 'memory',
        adapter,
        markDirty() {},
        async flush() {},
        async destroy() {
          db.exec(
            `SELECT 'DROP TABLE ' || quote(name) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
          );
          for (const r of adapter.all(
            `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
          )) {
            adapter.exec(`DROP TABLE IF EXISTS "${String(r['name']).replace(/"/g, '""')}"`);
          }
          adapter.exec('PRAGMA user_version = 0');
        },
      };
    },
  };
}
