/**
 * `granth/worker` — everything the database worker needs, from one package.
 *
 * This half is bundled SEPARATELY from your app: the worker is its own entry
 * point, so the SQL engine, the storage backends and sqlite-wasm never reach
 * your main-thread bundle. That separation is the whole reason these are a
 * subpath rather than exports of `granthdb` itself.
 */

export { startGranthWorker } from 'granth-runtime-worker/entry';
export type { StartWorkerOptions } from 'granth-runtime-worker/entry';

export { opfsStorage, sqliteWasmAdapter } from 'granth-storage-opfs';
export { indexeddbStorage } from 'granth-storage-indexeddb';
export { memoryStorage } from 'granth-storage-memory';

export { createEngine, rpcHandlers } from 'granth-engine';
export type { Engine, Adapter, MigrateResult } from 'granth-engine';
export type { StoragePlugin, StorageHandle } from 'granth-protocol';
