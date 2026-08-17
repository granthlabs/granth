// Separate database for the migration target, so it cannot collide with the
// fallback suite's schema version.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
// One package, one import — the worker half is a separate bundle.
import { startGranthWorker, opfsStorage, indexeddbStorage, memoryStorage } from 'granth/worker';

startGranthWorker({
  storage: [opfsStorage(), indexeddbStorage(), memoryStorage()], sqlite3InitModule, filename: '/migrated.sqlite3', storage: [indexeddbStorage()], checkpointMs: 50 });
