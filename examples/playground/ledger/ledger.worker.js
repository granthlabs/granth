import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { startGranthWorker, opfsStorage, indexeddbStorage, memoryStorage } from 'granthdb/worker';

startGranthWorker({
  sqlite3InitModule,
  filename: '/granth-ledger.sqlite3',
  storage: [opfsStorage(), indexeddbStorage(), memoryStorage()],
});
