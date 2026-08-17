// Separate OPFS file from the correctness playground — sharing one would make
// the two suites fight over schema versions.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
// One package, one import — the worker half is a separate bundle.
import { startGranthWorker, opfsStorage, indexeddbStorage, memoryStorage } from 'granthdb/worker';

// ?sync=normal lets the bench measure the durability/speed trade-off.
const params = new URL(self.location.href).searchParams;
const pragmas = {};
if (params.get('sync')) pragmas.synchronous = params.get('sync');
if (params.get('journal')) pragmas.journal_mode = params.get('journal');

startGranthWorker({
  storage: [opfsStorage(), indexeddbStorage(), memoryStorage()], sqlite3InitModule, filename: '/bench.sqlite3', pragmas });
