// Forces the IndexedDB fallback, so the path Safari private browsing takes is
// actually exercised rather than assumed.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { startGranthWorker } from '@granth/runtime-worker/entry';
import { opfsStorage } from '@granth/storage-opfs';
import { indexeddbStorage } from '@granth/storage-indexeddb';
import { memoryStorage } from '@granth/storage-memory';

startGranthWorker({
  storage: [opfsStorage(), indexeddbStorage(), memoryStorage()],
  sqlite3InitModule,
  filename: '/fallback.sqlite3',
  storage: [indexeddbStorage()],
  checkpointMs: 50,
});
