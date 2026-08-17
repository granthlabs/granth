# Storage

## OPFS first, IndexedDB as fallback

Storage is an **ordered list of plugins**, not a mode string. The first available
one wins, and an `open()` failure falls through to the next — availability is a
prediction, opening is the proof.

```js
// db.worker.js
import { startGranthWorker } from '@granth/runtime-worker/entry';
import { opfsStorage } from '@granth/storage-opfs';
import { indexeddbStorage } from '@granth/storage-indexeddb';
import { memoryStorage } from '@granth/storage-memory';

startGranthWorker({
  sqlite3InitModule,
  filename: '/myapp.sqlite3',
  storage: [opfsStorage(), indexeddbStorage(), memoryStorage()],
});
```

```js
await db.storageKind(); // -> 'opfs' | 'indexeddb' | 'memory'
```

| Plugin | Persists | Works where |
|---|---|---|
| `@granth/storage-opfs` | in place, fastest | a dedicated Worker + OPFS |
| `@granth/storage-indexeddb` | debounced whole-file checkpoint | anywhere IndexedDB exists, incl. Safari private browsing |
| `@granth/storage-memory` | not at all | absolutely everywhere: Node, SSR, tests, sandboxed frames |

Drop `memoryStorage()` from the list if you would rather fail loudly than run
against a store that silently forgets on reload.

OPFS is the fast path, but it is **not universally available**:

- **Safari private browsing has no OPFS at all** — a hard failure, not a slow path.
- Chrome incognito caps an OPFS database at ~100 MB, with surprising errors at the limit.
- iOS Capacitor apps lose access handles when backgrounded.

`'auto'` (the default) tries OPFS and falls back to IndexedDB, so your app keeps working in a
private window instead of throwing.

### The fallback is the same engine

Not a second implementation: the same SQLite build on an in-memory database, whose bytes are
checkpointed into IndexedDB. Every query, index, trigger and migration behaves identically.

Trade-offs worth knowing:

- checkpoints are **debounced and whole-file**, so cost is O(database size). Right for the
  fallback case (tens of MB); wrong as a primary store.
- writes since the last checkpoint are lost on a crash. `close()` flushes automatically; call
  `await db.flush()` before anything you cannot lose.

## The local database is a cache, never the source of truth

Browser storage is **evictable**:

- Safari evicts all script-writable storage after **7 days** without site interaction (ITP).
  Home-screen PWAs and `navigator.storage.persist()` are exempt.
- Cleanup tools delete OPFS as "Internet Cache"; Windows low-disk cleanup clears it.
- Field data across the ecosystem shows ~0.1–0.2% of users hit corruption anyway.

So:

```js
await navigator.storage.persist();            // ask to be exempt from eviction
const { quota, usage } = await navigator.storage.estimate();
const bytes = await db.size();                // what we actually occupy
```

**Always keep a rebuild-from-server path.**

## Multi-tab

`opfs-sahpool` is the fastest OPFS VFS and needs no COOP/COEP headers, at the cost of allowing
exactly one connection. [`opfs-leader`](https://www.npmjs.com/package/opfs-leader) elects one tab
via Web Locks; its worker is the only thing that opens the file, and every other tab routes
queries to it. When that tab dies the browser releases the lock and another takes over.

Two tabs writing one OPFS file is what corrupted Notion's first WASM-SQLite rollout. This is the
fix, not a mitigation.

## Worker options

```js
startGranthWorker({
  sqlite3InitModule,
  filename: '/myapp.sqlite3',
  storage: [opfsStorage(), indexeddbStorage(), memoryStorage()],
  checkpointMs: 250,                 // IndexedDB checkpoint debounce
  pragmas: { cache_size: -8000 },    // optional
  upgrades: { 2: (engine) => { /* data migration */ } },
});
```

`PRAGMA synchronous = NORMAL` was measured and made **no meaningful difference**, so it is not
recommended — single-row write cost is the durable commit itself, not fsync tuning. Batch your
writes instead.
