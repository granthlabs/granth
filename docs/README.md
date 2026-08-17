# granth — API Reference

SQLite in the browser with a **Dexie-compatible API**. OPFS-backed, one worker, safe across
tabs, with an IndexedDB fallback.

One page per class, plus guides for the parts that are structural rather than
API-shaped — storage, runtimes and plugins. Coming from another IndexedDB
wrapper? Start with [Migrating from Dexie](./MigratingFromDexie.md), which lists
every behavioural difference.

## Getting started

- [Tutorial](./Tutorial.md) — install, schema, first query
- [Migrating from Dexie or IndexedDB](./MigratingFromDexie.md) — compatibility matrix + data import
- [Storage: OPFS and the IndexedDB fallback](./Storage.md) — durability, quotas, eviction

## API Reference

| Class | Purpose |
|---|---|
| [Granth](./Granth.md) | The database itself — schema, versions, open/close, transactions |
| [Table](./Table.md) | One object store: CRUD, bulk operations, hooks |
| [Collection](./Collection.md) | A pending query result: ordering, paging, iteration, bulk edit |
| [WhereClause](./WhereClause.md) | The operators you reach through `table.where(index)` |
| [Transaction](./Transaction.md) | Both transaction forms and their isolation guarantees |
| [liveQuery](./liveQuery.md) | Reactive queries that re-run on change, across tabs |
| [Errors](./Errors.md) | Error types and which are safe to retry |
| [Runtimes](./Runtimes.md) | Worker vs inline (no-Worker) execution |
| [Plugins](./Plugins.md) | The three extension points, and the package map |

## Quick reference

```js
import Granth from 'granthdb';

const db = new Granth('myapp', {
  worker: () => new Worker(new URL('./db.worker.js', import.meta.url), { type: 'module' }),
});

db.version(1).stores({
  friends: '++id, name, age, *tags, [name+age]',
  notes:   '++id, owner, created',
});

await db.open();
```

```js
// db.worker.js — the entire file
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { startGranthWorker } from 'granth-runtime-worker/entry';
import { opfsStorage } from 'granth-storage-opfs';
import { indexeddbStorage } from 'granth-storage-indexeddb';
import { memoryStorage } from 'granth-storage-memory';

startGranthWorker({
  sqlite3InitModule,
  filename: '/myapp.sqlite3',
  storage: [opfsStorage(), indexeddbStorage(), memoryStorage()],
});
```

### Schema syntax

Identical to Dexie. The first entry is the primary key.

| Prefix | Meaning | Example |
|---|---|---|
| `++` | auto-incrementing primary key | `++id` |
| `&` | unique index | `&email` |
| `*` | multiEntry index (indexes each array element) | `*tags` |
| `[A+B]` | compound index | `[firstName+lastName]` |
| *(none)* | plain index | `age` |

Fields that are not indexed are still stored — you just cannot `where()` on them.
Nested keyPaths work: `address.city`.

### Cheat sheet

```js
await db.friends.add({ name: 'ada', age: 36, tags: ['math'] });
await db.friends.get(1);
await db.friends.where('age').above(30).toArray();
await db.friends.where('tags').equals('math').toArray();          // multiEntry
await db.friends.where('[name+age]').equals(['ada', 36]).first(); // compound
await db.friends.where({ name: 'ada', age: 36 }).toArray();       // multi-index equality
await db.friends.orderBy('age').reverse().limit(10).toArray();
await db.friends.where('age').below(18).modify({ junior: true });
await db.friends.where('name').startsWith('a').delete();

const sub = db.liveQuery(() => db.friends.toArray()).subscribe(render);
```

## Requirements

- A **secure context** (HTTPS or `localhost`) — OPFS and Web Locks both require it.
- Chrome 108+, Safari 16.4+, Firefox 111+.
- No COOP/COEP headers.
- Peer dependency: `@sqlite.org/sqlite-wasm`.
