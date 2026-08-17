import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
// One package, one import — the worker half is a separate bundle.
import { startGranthWorker, opfsStorage, indexeddbStorage, memoryStorage } from 'granth/worker';

startGranthWorker({
  sqlite3InitModule,
  filename: '/demo-todos.sqlite3',
  storage: [opfsStorage(), indexeddbStorage(), memoryStorage()],
});
