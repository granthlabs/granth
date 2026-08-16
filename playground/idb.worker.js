// Forces the IndexedDB fallback, so the path Safari private browsing takes is
// actually exercised rather than assumed.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { startLitieWorker } from 'litie/worker';

startLitieWorker({
  sqlite3InitModule,
  filename: '/fallback.sqlite3',
  storage: 'indexeddb',
  checkpointMs: 50,
});
