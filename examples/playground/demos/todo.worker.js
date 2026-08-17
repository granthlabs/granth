import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { startGranthWorker } from '@granth/runtime-worker/entry';
import { opfsStorage } from '@granth/storage-opfs';
import { indexeddbStorage } from '@granth/storage-indexeddb';
import { memoryStorage } from '@granth/storage-memory';

startGranthWorker({
  sqlite3InitModule,
  filename: '/demo-todos.sqlite3',
  storage: [opfsStorage(), indexeddbStorage(), memoryStorage()],
});
