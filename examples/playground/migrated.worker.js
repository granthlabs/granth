// Separate database for the migration target, so it cannot collide with the
// fallback suite's schema version.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { startGranthWorker } from '@granth/runtime-worker/entry';
import { opfsStorage } from '@granth/storage-opfs';
import { indexeddbStorage } from '@granth/storage-indexeddb';
import { memoryStorage } from '@granth/storage-memory';

startGranthWorker({
  storage: [opfsStorage(), indexeddbStorage(), memoryStorage()], sqlite3InitModule, filename: '/migrated.sqlite3', storage: [indexeddbStorage()], checkpointMs: 50 });
