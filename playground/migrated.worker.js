// Separate database for the migration target, so it cannot collide with the
// fallback suite's schema version.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { startLitieWorker } from 'litie/worker';

startLitieWorker({ sqlite3InitModule, filename: '/migrated.sqlite3', storage: 'indexeddb', checkpointMs: 50 });
