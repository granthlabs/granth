import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
// One package, one import — the worker half is a separate bundle.
import { startGranthWorker, opfsStorage, indexeddbStorage, memoryStorage } from 'granth/worker';

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
