# granth

**SQLite in the browser, with a Dexie-compatible API.**
OPFS-backed, runs in a Web Worker, safe across tabs, with an IndexedDB fallback.

```bash
npm install granth @sqlite.org/sqlite-wasm
```

```js
import Granth from 'granth';

const db = new Granth('myapp', {
  worker: () => new Worker(new URL('./db.worker.js', import.meta.url), { type: 'module' }),
});

db.version(1).stores({
  friends: '++id, name, age, *tags, [name+age]',
});

await db.friends.add({ name: 'ada', age: 36, tags: ['math'] });
await db.friends.where('age').above(30).toArray();
```

Your entire worker file:

```js
// db.worker.js
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { startGranthWorker } from 'granth-runtime-worker/entry';
import { opfsStorage } from 'granth-storage-opfs';
import { indexeddbStorage } from 'granth-storage-indexeddb';
import { memoryStorage } from 'granth-storage-memory';

startGranthWorker({
  sqlite3InitModule,
  filename: '/myapp.sqlite3',
  // Ordered: the first available backend wins, so this degrades instead of throwing.
  storage: [opfsStorage(), indexeddbStorage(), memoryStorage()],
});
```

**No COOP/COEP headers. No build plugins. No server.**

---

## Why

Dexie is excellent, but it is a wrapper over **IndexedDB** — per-row cost, cursor walking, no
query planner, and main-thread work. granth keeps the API and swaps the engine for **SQLite**:
real indexes, a real query planner, real transactions, running off the main thread.

The name follows Dexie's own: *inDEXed → Dexie*, so *sq**LITE** → granth*.

### What a SQL engine gives you

**Filter on one index and order by another.** A cursor-based store can only use one index per
query; a query planner has no such limit:

```js
await db.issues.where('key').anyOf(['a','b']).orderBy('updated_at').limit(10).toArray();
```

Plus a few conveniences that fall out of having real SQL underneath:

| | |
|---|---|
| `toMap(keyPath?)` | results keyed by primary key, or any keyPath |
| `for await (const doc of collection)` | stream a query without materialising it yourself |
| `db.clearAll()` | empty every table, keep the schema |
| `db.size()` | bytes on disk |
| Queries auto-open | no "call `open()` first" ordering trap |

## Compatibility

The API is diffed against the **real `dexie` package** by a generated audit that fails the build
on any regression:

| Class | Coverage |
|---|---|
| `WhereClause` | **18 / 18** |
| `Table` | 27 / 28 |
| `Collection` | 26 / 28 |
| `Dexie` | 20 / 26 |

Every gap is an explicit, documented waiver (middleware, `idbdb`, PSD zones — things with no
meaning once the store isn't IndexedDB). Migrating? → **[Migrating from Dexie](./docs/MigratingFromDexie.md)**

```js
import { suggestSchema, importFromIndexedDB } from 'granth-migrate-idb';

db.version(1).stores(await suggestSchema('my-old-dexie-db'));
await importFromIndexedDB(db, { from: 'my-old-dexie-db' });
```

Reads the schema out of your existing IndexedDB, preserves primary keys, rebuilds every index,
and is idempotent.

## Works with everything

| | |
|---|---|
| **React / Next.js** | `import { useLiveQuery } from 'granth-react'` — SSR-safe |
| **Vue / Nuxt** | `import { useLiveQuery } from 'granth-vue'` |
| **Angular** | `from(db.liveQuery(...))` — implements `Symbol.observable` |
| **Svelte** | `$query` directly — `subscribe()` *is* the Svelte store contract |
| **Vanilla / Solid / Qwik / Lit** | `.subscribe(fn)` |

`new Granth(...)` touches no browser API, so it is safe at module scope under SSR.
→ **[Frameworks guide](./docs/Frameworks.md)**

## Live queries

```js
const stop = db.liveQuery(() => db.friends.where('age').above(30).toArray())
  .subscribe(render);
```

Re-runs on changes from **any tab**, and only emits when the result actually differs.

## Performance

5,000 documents, Chrome, M-series Mac ([`playground/bench.html`](./examples/playground/bench.html)):

| Operation | Time |
|---|---:|
| `bulkAdd` 5,000 docs | 295 ms (~17,000 rows/s) |
| indexed `where().equals()` | 2.5 ms |
| compound index lookup | 1.1 ms |
| multiEntry lookup | 9 ms |
| `orderBy().offset(2500).limit(50)` | 1.0 ms |
| full scan, 5,200 docs | 26 ms |
| `bulkGet` 500 keys | 5 ms |

**Batch your writes** — `bulkAdd` is ~200× the throughput of one-at-a-time, because each
individual write is its own durable commit.

## Storage

Storage is an **ordered list of plugins** — `[opfs, indexeddb, memory]`. The first available one
wins and an `open()` failure falls through, because **Safari private browsing has no OPFS at
all**: a hard failure, not a slow path. Every backend is the *same* SQLite engine, so behaviour
is identical; only durability differs.

Browser storage is evictable (Safari's 7-day ITP rule, cleanup tools, incognito caps).
**Treat the local database as a cache or replica, never the source of truth.**
→ **[Storage guide](./docs/Storage.md)**

## Multi-tab

`opfs-sahpool` is the fastest OPFS VFS and needs no cross-origin isolation, at the cost of
allowing exactly one connection. [`opfs-leader`](./packages/opfs-leader) (also published standalone)
elects one tab via Web Locks; its worker is the only thing that opens the file, and every other
tab routes queries to it. When that tab dies the browser releases the lock and another takes
over — that release *is* the failover.

Two tabs writing one OPFS file is what corrupted
[Notion's first WASM-SQLite rollout](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite).
This is the fix, not a mitigation.

## Everything is a plugin

```
StoragePlugin   where the bytes live      opfs | indexeddb | memory
RuntimePlugin   where the SQL executes    worker | inline (no Worker)
db.use(addon)   everything else           hooks, returns a disposer
```

`granth-protocol` holds the contracts — types only, zero runtime, zero deps — so backends and
bindings never import each other or the client. Runs **without a Worker** too, for strict CSP,
SSR, Node and tests. → **[Plugins](./docs/Plugins.md)** · **[Runtimes](./docs/Runtimes.md)**

## Migrating from Dexie

```bash
npx granth-codemod ./src
```

Rewrites imports and constructors, scaffolds the worker file, and reports what it cannot safely
change rather than guessing. Then bring the data across:

```js
import { suggestSchema, importFromIndexedDB } from 'granth-migrate-idb';
db.version(1).stores(await suggestSchema('my-old-dexie-db'));
await importFromIndexedDB(db, { from: 'my-old-dexie-db' });
```

## Examples

Live in [`examples/playground/demos`](./examples/playground/demos) — the same database and the
same queries in each, so only the binding differs.

| | |
|---|---|
| [Vanilla JS](./examples/playground/demos/vanilla.js) | `subscribe()` straight into the DOM |
| [React](./examples/playground/demos/react.jsx) | `granth-react`, SSR-safe |
| [Vue](./examples/playground/demos/vue.js) | `granth-vue` composable |
| [No Worker](./examples/playground/demos/no-worker.js) | inline runtime on IndexedDB |

Angular and Svelte need no adapter — see the [Frameworks guide](./docs/Frameworks.md).

```bash
npm install && npm run dev     # then open /demos/
```

## Documentation

**Site: https://sundarshahi.github.io/granth**

- [Tutorial](./docs/Tutorial.md) · [Migrating from Dexie](./docs/MigratingFromDexie.md) · [Frameworks](./docs/Frameworks.md)
- [Storage](./docs/Storage.md) · [Runtimes](./docs/Runtimes.md) · [Plugins](./docs/Plugins.md) · [Security & performance](./docs/SecurityAndPerformance.md)
- API: [Granth](./docs/Granth.md) · [Table](./docs/Table.md) · [Collection](./docs/Collection.md) · [WhereClause](./docs/WhereClause.md) · [Transaction](./docs/Transaction.md) · [liveQuery](./docs/liveQuery.md) · [Errors](./docs/Errors.md)

## How it works

Documents are JSON in a `_doc` column. Every declared index becomes a **virtual generated
column** (`json_extract`) plus a real SQLite index; `*multiEntry` gets a shadow table maintained
by triggers; `[a+b]` is a composite index; `update()` is `json_patch` (RFC 7396 merge).

The client builds **serializable query plans** and the worker compiles them to SQL — no SQL
strings, functions or `eval` cross `postMessage`.

There is no custom B-tree and no key encoding. Indexes, transactions, query planning and
durability are SQLite's job. That is why this is small enough to trust.

## Testing

The engine is environment-agnostic, so it is tested against **real SQLite** in Node
(`node:sqlite`) — DDL, triggers and compiled SQL genuinely execute — and then against **real
sqlite-wasm + OPFS** in a browser, including durability across a full page reload.

```bash
npm test          # engine suite + dexie compat audit + typecheck
npm run dev       # browser suites: / , /compat.html , /bench.html
```

## Requirements

Chrome 108+ · Safari 16.4+ · Firefox 111+ · secure context (HTTPS or `localhost`).

## Packages

| Package | Description |
|---|---|
| [`granth`](./packages/core/client) | The database — what you import |
| [`granth-protocol`](./packages/core/protocol) | Plugin contracts, types only |
| [`granth-engine`](./packages/core/engine) | Schema, planner, SQL compiler, value codec |
| [`granth-storage-opfs`](./packages/storage/opfs) · [`-indexeddb`](./packages/storage/indexeddb) · [`-memory`](./packages/storage/memory) | Storage backends |
| [`granth-runtime-worker`](./packages/runtime/worker) · [`-inline`](./packages/runtime/inline) | Runtimes |
| [`granth-react`](./packages/bindings/react) · [`granth-vue`](./packages/bindings/vue) | Framework bindings |
| [`granth-migrate-idb`](./packages/plugins/migrate-idb) | Import an existing IndexedDB/Dexie database |
| [`granth-codemod`](./packages/tools/codemod) | Automated Dexie → granth source migration |
| [`opfs-leader`](./packages/opfs-leader) | The multi-tab election, usable standalone |

## License

MIT
