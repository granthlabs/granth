import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { startGranthWorker } from '@granth/runtime-worker/entry';
import { opfsStorage } from '@granth/storage-opfs';
import { indexeddbStorage } from '@granth/storage-indexeddb';
import { memoryStorage } from '@granth/storage-memory';

startGranthWorker({
  sqlite3InitModule,
  filename: '/playground.sqlite3',
  // Ordered: OPFS where it exists, IndexedDB where it does not (Safari private
  // browsing), memory as the last resort so the app degrades instead of throwing.
  storage: [opfsStorage(), indexeddbStorage(), memoryStorage()],
  upgrades: {
    2: (engine) => {
      for (const f of engine.query('friends', { or: [] }, 'docs')) {
        if (f.city === undefined) engine.update('friends', f.id, { city: 'unknown' });
      }
    },
  },
});
