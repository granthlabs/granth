// Separate database for the migration target, so it cannot collide with the
// fallback suite's schema version.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { startGranthWorker } from 'granth/worker';

startGranthWorker({ sqlite3InitModule, filename: '/migrated.sqlite3', storage: 'indexeddb', checkpointMs: 50 });
