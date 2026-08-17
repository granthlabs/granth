// Forces the IndexedDB fallback, so the path Safari private browsing takes is
// actually exercised rather than assumed.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
// One package, one import — the worker half is a separate bundle.
import { startGranthWorker, opfsStorage, indexeddbStorage, memoryStorage } from 'granth/worker';

startGranthWorker({
  storage: [opfsStorage(), indexeddbStorage(), memoryStorage()],
  sqlite3InitModule,
  filename: '/fallback.sqlite3',
  storage: [indexeddbStorage()],
  checkpointMs: 50,
});
