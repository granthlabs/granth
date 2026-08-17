# litie

**SQLite in the browser, with a Dexie-compatible API.**
OPFS-backed, runs in a Web Worker, safe across tabs, with an IndexedDB fallback.

```bash
npm install litie @sqlite.org/sqlite-wasm
```

```js
import Litie from 'litie';

const db = new Litie('myapp', {
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
import { startLitieWorker } from 'litie/worker';

startLitieWorker({ sqlite3InitModule, filename: '/myapp.sqlite3' });
```

**No COOP/COEP headers. No build plugins. No server.**

---

## Why

Dexie is excellent, but it is a wrapper over **IndexedDB** — per-row cost, cursor walking, no
query planner, and main-thread work. litie keeps the API and swaps the engine for **SQLite**:
real indexes, a real query planner, real transactions, running off the main thread.

The name follows Dexie's own: *inDEXed → Dexie*, so *sq**LITE** → litie*.

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
import { suggestSchema, importFromIndexedDB } from 'litie/migrate-idb';

db.version(1).stores(await suggestSchema('my-old-dexie-db'));
await importFromIndexedDB(db, { from: 'my-old-dexie-db' });
```

Reads the schema out of your existing IndexedDB, preserves primary keys, rebuilds every index,
and is idempotent.

## Works with everything

| | |
|---|---|
| **React / Next.js** | `import { useLiveQuery } from 'litie/react'` — SSR-safe |
| **Vue / Nuxt** | `import { useLiveQuery } from 'litie/vue'` |
| **Angular** | `from(db.liveQuery(...))` — implements `Symbol.observable` |
| **Svelte** | `$query` directly — `subscribe()` *is* the Svelte store contract |
| **Vanilla / Solid / Qwik / Lit** | `.subscribe(fn)` |

`new Litie(...)` touches no browser API, so it is safe at module scope under SSR.
→ **[Frameworks guide](./docs/Frameworks.md)**

## Live queries

```js
const stop = db.liveQuery(() => db.friends.where('age').above(30).toArray())
  .subscribe(render);
```

Re-runs on changes from **any tab**, and only emits when the result actually differs.

## Performance

5,000 documents, Chrome, M-series Mac ([`playground/bench.html`](./playground/bench.html)):

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

`storage: 'auto'` uses OPFS and falls back to IndexedDB — because **Safari private browsing has
no OPFS at all**, which is a hard failure rather than a slow path. The fallback is the *same*
SQLite engine, checkpointed into IndexedDB, so behaviour is identical.

Browser storage is evictable (Safari's 7-day ITP rule, cleanup tools, incognito caps).
**Treat the local database as a cache or replica, never the source of truth.**
→ **[Storage guide](./docs/Storage.md)**

## Multi-tab

`opfs-sahpool` is the fastest OPFS VFS and needs no cross-origin isolation, at the cost of
allowing exactly one connection. [`opfs-leader`](./opfs-leader) (also published standalone)
elects one tab via Web Locks; its worker is the only thing that opens the file, and every other
tab routes queries to it. When that tab dies the browser releases the lock and another takes
over — that release *is* the failover.

Two tabs writing one OPFS file is what corrupted
[Notion's first WASM-SQLite rollout](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite).
This is the fix, not a mitigation.

## Documentation

Mirrors [Dexie's API Reference](https://dexie.org/docs/API-Reference) page for page.

- [Tutorial](./docs/Tutorial.md) · [Migrating from Dexie](./docs/MigratingFromDexie.md) · [Frameworks](./docs/Frameworks.md) · [Storage](./docs/Storage.md)
- API: [Litie](./docs/Litie.md) · [Table](./docs/Table.md) · [Collection](./docs/Collection.md) · [WhereClause](./docs/WhereClause.md) · [Transaction](./docs/Transaction.md) · [liveQuery](./docs/liveQuery.md) · [Errors](./docs/Errors.md)

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
| [`litie`](./litie) | The database |
| [`opfs-leader`](./opfs-leader) | Just the multi-tab single-writer topology, usable on its own |

## License

MIT
