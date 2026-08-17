// Forces the IndexedDB fallback, so the path Safari private browsing takes is
// actually exercised rather than assumed.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { startGranthWorker } from 'granth/worker';

startGranthWorker({
  sqlite3InitModule,
  filename: '/fallback.sqlite3',
  storage: 'indexeddb',
  checkpointMs: 50,
});
