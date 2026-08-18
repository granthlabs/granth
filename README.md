# granth

**A database that lives inside the browser tab.**

granth stores your app's data on the user's own device using [SQLite](https://sqlite.org),
compiled to WebAssembly. Reads and writes are local, so they are fast and work offline. The API
is a drop-in match for [Dexie](https://dexie.org), so most existing code keeps working.

```js
await db.friends.add({ name: 'Ada', age: 36 });

const grownUps = await db.friends.where('age').above(30).toArray();
```

**[Try it in your browser →](https://sundarshahi.github.io/granth/play/sandbox)** — a real
database, no install.

---

## Is this for you?

**Good fit**

- A web app that must keep working offline, or feel instant on a bad connection.
- More data than you want to hold in memory, and you need to filter, sort or page it.
- You already use Dexie or IndexedDB and want real indexes and a query planner.

**Not a fit**

- A handful of small values — `localStorage` is simpler and fine.
- Data that must be authoritative. Browser storage is **evictable**: Safari deletes it after
  7 days of no visits, and users clear it. Treat this as a fast local copy, never the only copy.
- Syncing edits between users. granth is local storage, not a sync engine.

## Install

```bash
npm install granthdb @sqlite.org/sqlite-wasm
```

Works in Chrome 108+, Safari 16.4+, Firefox 111+, over HTTPS or `localhost`.
The suite runs on Chromium, Firefox and WebKit in CI. Where OPFS is unavailable — Safari
private browsing, for instance — it falls back to IndexedDB automatically, and the same
suite passes on that path.
No special server headers, no bundler plugins, no build step.

## Quick start

**1. Create the database.** Give it a name and a version, and declare which fields you want to
search by.

```js
// db.js
import Granth from 'granthdb';

export const db = new Granth('myapp', {
  worker: () => new Worker(new URL('./db.worker.js', import.meta.url), { type: 'module' }),
});

db.version(1).stores({
  //        ↓ primary key, auto-numbered
  friends: '++id, name, age',
  //               ↑ these become real indexes you can query on
});
```

**2. Add the worker file.** SQLite runs on a background thread so it never freezes your UI.
This file is the whole of it — copy it as-is.

```js
// db.worker.js
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { startGranthWorker, opfsStorage, indexeddbStorage, memoryStorage } from 'granthdb/worker';

startGranthWorker({
  sqlite3InitModule,
  filename: '/myapp.sqlite3',
  // Tried in order. The first one the browser supports wins, so this degrades
  // instead of throwing — Safari private windows have no OPFS at all.
  storage: [opfsStorage(), indexeddbStorage(), memoryStorage()],
});
```

**3. Use it.** No `open()` call needed — the first query opens the database.

```js
import { db } from './db.js';

await db.friends.add({ name: 'Ada', age: 36 });
await db.friends.bulkAdd([{ name: 'Grace', age: 45 }, { name: 'Radia', age: 38 }]);

await db.friends.get(1);
await db.friends.where('age').above(30).toArray();
await db.friends.where('name').startsWith('A').count();
await db.friends.update(1, { age: 37 });
await db.friends.delete(1);
```

**4. Keep the UI in sync.** A live query re-runs whenever the data changes — including changes
made in another tab — and only tells you when the answer actually differs.

```js
const stop = db.liveQuery(() => db.friends.where('age').above(30).toArray())
  .subscribe((friends) => render(friends));

// later
stop();
```

→ Full walkthrough: **[Tutorial](https://sundarshahi.github.io/granth/tutorial)**

## Schema syntax

The string after each table name declares the primary key first, then the fields you can query.

| You write | Meaning |
|---|---|
| `++id` | Primary key, numbered automatically |
| `id` | Primary key you supply yourself |
| `name` | Index — lets you query `where('name')` |
| `&email` | Index that must be unique |
| `*tags` | Field holding an array; matches any element |
| `[name+age]` | One index over two fields together |

Fields you never search by do not need to be listed — they are still stored.

## Using it with your framework

| | |
|---|---|
| **React / Next.js** | `import { useLiveQuery } from 'granth-react'` — safe under SSR |
| **Vue / Nuxt** | `import { useLiveQuery } from 'granth-vue'` |
| **Svelte** | `$query` works directly — `subscribe()` *is* the store contract |
| **Angular** | `from(db.liveQuery(...))` — it implements `Symbol.observable` |
| **Solid / Qwik / Lit / vanilla** | `.subscribe(fn)` |

Creating a `Granth` touches no browser API, so it is safe at module scope during
server-side rendering.

→ **[Frameworks guide](https://sundarshahi.github.io/granth/frameworks)** ·
**[TanStack Query, RxJS, Zustand](https://sundarshahi.github.io/granth/state-libraries)**

## Coming from Dexie

Most code needs no changes. Start with the codemod:

```bash
npx granth-codemod ./src
```

It rewrites imports and constructors, writes the worker file, and **reports whatever it cannot
safely change** rather than guessing. Then bring your existing data across:

```js
import { suggestSchema, importFromIndexedDB } from 'granth-migrate-idb';

db.version(1).stores(await suggestSchema('my-old-dexie-db'));
await importFromIndexedDB(db, { from: 'my-old-dexie-db' });
```

This reads the schema out of your existing IndexedDB, keeps primary keys, rebuilds every index,
and is safe to run twice.

The API is diffed against the **real `dexie` package** on every commit, and separately a
differential test runs the same script against both and compares the answers:

| Class | Covered |
|---|---|
| `WhereClause` | **18 / 18** |
| `Table` | 27 / 28 |
| `Collection` | 26 / 28 |
| `Dexie` | 21 / 26 |

Each gap is a documented waiver — middleware, `idbdb`, PSD zones — things with no meaning once
the store is not IndexedDB.

→ **[Migrating from Dexie](https://sundarshahi.github.io/granth/migrating-from-dexie)**

## Why SQLite instead of IndexedDB

Dexie is excellent, but IndexedDB underneath it has no query planner: one index per query, and
the rest is cursor walking on the main thread.

**Filter on one index and sort by another** — impossible for a cursor, ordinary for SQL:

```js
await db.issues.where('status').anyOf(['open', 'blocked'])
  .orderBy('updated_at').limit(10).toArray();
```

A few other things fall out of having SQL underneath:

| | |
|---|---|
| `toMap(keyPath?)` | results keyed by id, or any field |
| `for await (const doc of collection)` | stream results without materialising them |
| `db.clearAll()` | empty every table, keep the schema |
| `db.size()` | bytes on disk |

## Performance

5,000 documents (~1.6 MB), Chrome, M-series Mac. Run
[`bench.html`](./examples/playground/bench.html) yourself — one machine's numbers, and query
times vary ±3× with load.

| Operation | Time |
|---|---:|
| `bulkAdd` 5,000 docs | 28 ms (~180,000 rows/s) |
| indexed `where().equals()` | 2.5 ms |
| compound index lookup | 1.1 ms |
| `orderBy().offset(2500).limit(50)` | 1.0 ms |
| full scan, 5,200 docs | 26 ms |
| `bulkGet` 500 keys | 5 ms |

**The one rule: batch your writes.** `bulkAdd` is ~200× the throughput of adding rows one at a
time, because each individual write is its own durable commit.

## How it works

Documents are stored as JSON in a `_doc` column. Every index you declare becomes a **virtual
generated column** plus a real SQLite index, so SQLite does the actual index work. Arrays
(`*tags`) get a shadow table kept in step by triggers, and `update()` is a JSON merge patch.

Your app builds **plain-data query plans**; the worker turns them into SQL. No SQL strings, no
functions and no `eval` ever cross between them.

There is no custom B-tree and no key encoding here. Indexes, transactions, planning and
durability are SQLite's job — which is why this is small enough to trust.

### Many tabs, one writer

The fastest OPFS backend allows exactly **one** connection to a file. So one tab is elected
writer via Web Locks; its worker is the only thing that opens the database, and every other tab
sends its queries there. When that tab closes, the browser releases the lock and another takes
over — that release *is* the failover.

Two tabs writing one file is what corrupted
[Notion's first WASM-SQLite rollout](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite).
This is the fix, not a mitigation.

### Everything is a plugin

```
StoragePlugin   where the bytes live      opfs | indexeddb | memory
RuntimePlugin   where the SQL runs        worker | inline (no Worker at all)
db.use(addon)   everything else           hooks; returns a disposer
```

It runs **without a Worker** too, for strict CSP, SSR, Node and tests.

→ **[Storage](https://sundarshahi.github.io/granth/storage)** ·
**[Runtimes](https://sundarshahi.github.io/granth/runtimes)** ·
**[Plugins](https://sundarshahi.github.io/granth/plugins)**

## Try it and see it

| | |
|---|---|
| **[Sandbox](https://sundarshahi.github.io/granth/play/sandbox)** | Write real queries against a real database |
| **[Examples](https://sundarshahi.github.io/granth/play/demos/)** | The same app in six frameworks |
| **[Verify](https://sundarshahi.github.io/granth/play/)** | Run the full browser test suite in *your* browser |

Locally:

```bash
npm install
npm run dev     # then open /sandbox or /demos/
```

## Documentation

**https://sundarshahi.github.io/granth**

- [Tutorial](https://sundarshahi.github.io/granth/tutorial) ·
  [Migrating from Dexie](https://sundarshahi.github.io/granth/migrating-from-dexie) ·
  [Frameworks](https://sundarshahi.github.io/granth/frameworks)
- [Replacing localStorage](https://sundarshahi.github.io/granth/replacing-web-storage) ·
  [Cache-first apps](https://sundarshahi.github.io/granth/cache-first-apps) ·
  [Encryption at rest](https://sundarshahi.github.io/granth/encryption)
- [Storage](https://sundarshahi.github.io/granth/storage) ·
  [Runtimes](https://sundarshahi.github.io/granth/runtimes) ·
  [Plugins](https://sundarshahi.github.io/granth/plugins) ·
  [Security & performance](https://sundarshahi.github.io/granth/security-and-performance)
- API: [Granth](https://sundarshahi.github.io/granth/granth) ·
  [Table](https://sundarshahi.github.io/granth/table) ·
  [Collection](https://sundarshahi.github.io/granth/collection) ·
  [WhereClause](https://sundarshahi.github.io/granth/where-clause) ·
  [Transaction](https://sundarshahi.github.io/granth/transaction) ·
  [liveQuery](https://sundarshahi.github.io/granth/live-query) ·
  [Errors](https://sundarshahi.github.io/granth/errors)

## Packages

You normally only install `granthdb`. The rest are its parts, published separately so you can
swap or reuse them.

| Package | What it is |
|---|---|
| [`granthdb`](./packages/core/client) | The database — the one you import |
| [`granth-protocol`](./packages/core/protocol) | Plugin contracts. Types only, no runtime code |
| [`granth-engine`](./packages/core/engine) | Schema, query planner, SQL compiler, value codec |
| [`granth-storage-opfs`](./packages/storage/opfs) · [`-indexeddb`](./packages/storage/indexeddb) · [`-memory`](./packages/storage/memory) | Storage backends |
| [`granth-runtime-worker`](./packages/runtime/worker) · [`-inline`](./packages/runtime/inline) | Where SQL executes |
| [`granth-react`](./packages/bindings/react) · [`granth-vue`](./packages/bindings/vue) | Framework bindings |
| [`granth-migrate-idb`](./packages/plugins/migrate-idb) | Import an existing IndexedDB/Dexie database |
| [`granth-codemod`](./packages/tools/codemod) | Automated Dexie → granth source migration |
| [`opfs-leader`](./packages/opfs-leader) | The multi-tab election, usable on its own |

## Contributing

Bug reports, reproductions and pull requests are all welcome — see
**[CONTRIBUTING.md](./CONTRIBUTING.md)** for how to set the project up, how it is tested, and
what a change needs before it can be merged.

The short version:

```bash
npm install
npm test        # Node suites: engine, client, Dexie parity, docs coverage, fuzz
```

## Security

Found a vulnerability? **Please do not open a public issue.** See
**[SECURITY.md](./SECURITY.md)** for how to report it privately and what to expect.

For the security properties of the library itself — what is and is not protected, what
encryption at rest does and does not cover — see
[Security & performance](https://sundarshahi.github.io/granth/security-and-performance).

## Name

*Granth* (ग्रंथ) is Sanskrit for a book or treatise — a bound thing you keep and refer back to.

The npm package is **`granthdb`**, not `granth`: npm rejects `granth` as too similar to the
existing `grunt`.

## License

[MIT](./LICENSE)
