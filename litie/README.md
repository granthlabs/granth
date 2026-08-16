# Litie

A **Dexie-shaped API over SQLite/WASM on OPFS**. Runs in one worker, safe across tabs,
with indexes, transactions and query planning done by SQLite rather than by us.

```bash
npm install litie @sqlite.org/sqlite-wasm
```

```js
import { Litie } from 'litie';

const db = new Litie('myapp', {
  worker: () => new Worker(new URL('./db.worker.js', import.meta.url), { type: 'module' }),
});

db.version(1).stores({
  friends: '++id, name, age, *tags, [name+age]',
  notes:   '++id, owner, created',
});
db.version(2).stores({ friends: '++id, name, age, city, *tags, [name+age]' }); // adds an index

await db.open();

await db.friends.add({ name: 'ada', age: 36, tags: ['math'] });
await db.friends.where('age').above(30).toArray();
await db.friends.where('tags').equals('math').toArray();
await db.friends.orderBy('age').reverse().limit(10).toArray();
```

Your whole worker file:

```js
// db.worker.js
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { startLitieWorker } from 'litie/worker';

startLitieWorker({ sqlite3InitModule, filename: '/myapp.sqlite3' });
```

No COOP/COEP headers required. Nothing to configure beyond your bundler letting
`@sqlite.org/sqlite-wasm` through (in Vite: `optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] }`).

## Why it's small enough to trust

Indexes, transactions, query planning and durability are **SQLite's job**. There is no
custom B-tree and no key encoding. Documents are JSON in a `_doc` column; every declared
index becomes a **VIRTUAL generated column** (`json_extract`) plus a real SQLite index.
`*multiEntry` gets a shadow table kept in sync by triggers. `[a+b]` is a composite index.
`update()` is `json_patch`, so RFC 7396 merge semantics come free.

The engine is environment-agnostic, so `selfcheck.mjs` runs it against **real SQLite** via
Node's built-in `node:sqlite`: the DDL, the triggers and the compiled SQL are genuinely
executed. The browser suite then verifies the platform layer against real sqlite-wasm + OPFS,
including durability across a full page reload.

## Coming from Dexie or raw IndexedDB

**The API is matched against the real `dexie` package by a generated audit**
(`compat-audit.mjs`), which runs in CI and fails if we regress or if Dexie grows a member
we do not cover. Current coverage: **WhereClause 18/18, Table 27/28, Collection 26/28,
Dexie 20/26** — every gap is an explicit, documented waiver.

Two Dexie behaviours are easy to get subtly wrong, so they are asserted, not assumed:
`sortBy()` resolves to a sorted **array** (not a Collection), and `keys()` returns the
**index** keys (not the primary keys).

Bring your existing data across:

```js
import { suggestSchema, importFromIndexedDB } from 'litie/migrate-idb';

const schema = await suggestSchema('my-old-dexie-db');  // derived from the real database
db.version(1).stores(schema);
await db.open();

await importFromIndexedDB(db, { from: 'my-old-dexie-db' });  // idempotent (bulkPut)
```

`suggestSchema` reads the existing object stores — auto-increment keys, unique, multiEntry
and compound indexes — and returns the `stores({...})` object matching them. The import
preserves primary keys and rebuilds every index. It does **not** delete the source: verify,
then delete it yourself.

### What cannot be identical

| Dexie | Here | Why |
|---|---|---|
| `db.transaction('rw', …, fn)` | ✅ supported | Holds an exclusive cross-tab Web Lock + a real SQLite transaction |
| `Table.hook(...)` | ✅ runs client-side | A JS function cannot cross into the worker, so a hook cannot veto an already-committed write |
| `Collection.modify(fn)` | ✅ read-modify-write in one atomic batch | Same reason |
| `Collection.distinct()` | no-op | Our multiEntry is an `IN` subquery, which never duplicates rows |
| `Dexie.use()` / `unuse()` | ✗ | No DBCore middleware layer |
| `db.backendDB()` / `idbdb` | ✗ | There is no IDBDatabase — the store is SQLite |
| `Dexie.Promise` / PSD zones | ✗ | Plain promises |

Schema changes without a version bump **throw a clear error** rather than being silently
ignored (Dexie requires the bump too; the failure here is loud instead of a later
"no such table").

## Storage: OPFS, with an IndexedDB fallback

OPFS is the fast path but it is **not universally available** — Safari private browsing has
no OPFS at all, which is a hard failure rather than a slow path. `storage: 'auto'` (the
default) tries OPFS and falls back to IndexedDB.

```js
startLitieWorker({ sqlite3InitModule, storage: 'auto' }); // 'opfs' | 'indexeddb' | 'auto'
await db.storageKind(); // -> 'opfs' | 'indexeddb'
```

The fallback is **the same SQLite engine**, not a second implementation: an in-memory
database whose bytes are checkpointed into IndexedDB. Every query, index, trigger and
migration behaves identically. The trade-offs are real and worth knowing:

- checkpoints are **debounced and whole-file**, so cost is O(database size) — right for the
  fallback case (tens of MB), wrong as a primary store;
- writes since the last checkpoint are lost on a crash. `close()` flushes automatically;
  call `await db.flush()` before anything you cannot lose.

## Multi-tab

`opfs-sahpool` is the fastest OPFS VFS and needs no cross-origin isolation, at the cost of
allowing **exactly one connection**. [`opfs-leader`](https://www.npmjs.com/package/opfs-leader)
elects one tab via Web Locks; its worker is the only thing that opens the file, and every
other tab's queries route to it. When that tab dies the browser releases the lock and another
takes over. Two tabs writing one OPFS file is what corrupted Notion's first rollout — this is
the fix, not a mitigation.

## Performance

Measured in Chrome on an M-series Mac, 5,000 documents (~1.6 MB OPFS file), via
`playground/bench.html`. Run it yourself — these are one machine's numbers, and query times
vary ±3× with load.

| Operation | Time | Rate |
|---|---:|---:|
| `bulkAdd` 5,000 docs (one transaction) | 295 ms | ~17,000 rows/s |
| `add` one at a time (durable commit each) | ~13 ms each | ~75 rows/s |
| `count()` whole table | 0.5 ms | |
| indexed `where(cat).equals(...)` | 2.5 ms | |
| compound `where([cat+n]).equals(...)` | 1.1 ms | |
| multiEntry `where(tags).equals(...)` | 9 ms | |
| `orderBy(n).offset(2500).limit(50)` | 1.0 ms | |
| full scan `toArray()` 5,200 docs | 26 ms | ~199,000 rows/s |
| `bulkGet` 500 keys (one round trip) | 5 ms | ~96,000 keys/s |
| `get()` 500 keys individually | 174 ms | ~2,900 keys/s |

**The one rule that matters: batch your writes.** A single `bulkAdd` is ~200× the throughput
of the same rows added one at a time, because each individual write is its own durable commit.
Likewise `bulkGet` beats a loop of `get()` by ~35× — it is one round trip instead of 500.

(`PRAGMA synchronous = NORMAL` was measured and made no meaningful difference, so it is not
recommended. The `pragmas` option exists if you want to experiment.)

## API

| | |
|---|---|
| **Table** | `get` `bulkGet` `add` `put` `update` `upsert` `bulkUpdate` `delete` `bulkAdd` `bulkPut` `bulkDelete` `clear` `count` `toArray` `each` `where` `orderBy` `filter` `limit` `offset` `reverse` `toCollection` `hook` `mapToClass` `schema` |
| **where(ix)** | `equals` `notEqual` `above` `aboveOrEqual` `below` `belowOrEqual` `between` `startsWith` `startsWithIgnoreCase` `startsWithAnyOf` `startsWithAnyOfIgnoreCase` `equalsIgnoreCase` `anyOf` `anyOfIgnoreCase` `noneOf` `isNull` `notNull` `inAnyRange` |
| **Collection** | `toArray` `first` `last` `count` `primaryKeys` `keys` `uniqueKeys` `firstKey` `lastKey` `each` `eachKey` `eachPrimaryKey` `eachUniqueKey` `limit` `offset` `reverse` `desc` `distinct` `until` `sortBy` `or` `filter` `and` `delete` `modify` |
| **db** | `version().stores()` `open` `transaction` `liveQuery` `onChange` `close` `delete` `deleteDatabase` `table` `tables` `isOpen` `hasBeenClosed` `hasFailed` `verno` `on` `once` `storageKind` `flush` |

`where({ name: 'ada', age: 36 })` is multi-index equality. `.or('name').equals('bob')` unions.
On a compound index, pass the tuple: `where('[name+age]').equals(['ada', 36])`.

### TypeScript

Ships hand-written declarations. Subclass to get typed tables, as with Dexie:

```ts
import { Litie, Table } from 'litie';

interface Friend { id?: number; name: string; age: number; tags?: string[] }

class MyDB extends Litie {
  friends!: Table<Friend, number>;
  constructor() {
    super('myapp', { worker: () => new Worker(new URL('./db.worker.js', import.meta.url), { type: 'module' }) });
    this.version(1).stores({ friends: '++id, name, age, *tags' });
    this.friends = this.table<Friend, number>('friends');
  }
}
```

### liveQuery

```js
const sub = db.liveQuery(() => db.friends.where('age').above(30).toArray())
  .subscribe(rows => render(rows));

sub.unsubscribe();
```

Re-runs on change **from any tab**, emits only when the result actually differs, and after its
first run only listens to the tables the querier actually read.

### Transactions

Two forms. The Dexie-compatible one is interactive — it can read:

```js
await db.transaction('rw', db.friends, db.notes, async () => {
  const n = await db.friends.count();          // a READ inside the transaction
  await db.notes.add({ owner: `friend-${n}` });
});
```

It holds an **exclusive cross-tab Web Lock** for its duration, so another tab's writes cannot
land inside it, plus a real SQLite transaction that rolls back on throw. Ordinary calls take a
shared lock, which is what makes that isolation hold.

The one-argument form is the fast path: the callback is **synchronous and records writes**,
shipped as a single atomic batch in one round trip. Use it when you don't need to read.

```js
await db.transaction(tx => {
  tx.friends.add({ name: 'eve', age: 22 });
  tx.notes.add({ owner: 'eve' });
});
```

## Deliberate limits

- **`.filter(fn)` and `.and(fn)` run client-side** — a JS function cannot cross into the
  worker. The worker returns all index matches, so narrow with `.where()` first on big tables.
  `.modify()` takes an object, not a function.
- **No `upgrade()` callbacks from the client.** Declarative schema changes (add/remove tables
  and indexes) are automatic; data transforms go in your worker's `upgrades: { 2: fn }`.
- **Changing a primary key throws** rather than silently rebuilding the table.
- **`equalsIgnoreCase` / `startsWithIgnoreCase` do not use the index.**
- **Not a sync engine.** No offline write queue, no conflict resolution, no server protocol.

## Storage is not durable

OPFS is evictable: Safari's 7-day ITP rule, Chrome's ~100 MB incognito cap (with surprising
errors), no OPFS at all in Safari private browsing, and cleanup tools that delete it as
"Internet Cache". Call `navigator.storage.persist()` and **always keep a rebuild-from-server
path**. Treat this as a cache or a replica, never the source of truth.

## Browser support

Chrome 108+, Safari 16.4+, Firefox 111+ — wherever OPFS sync access handles and Web Locks
exist. Requires a secure context (HTTPS or localhost).

## Test

```bash
npm test              # node:sqlite engine suite + dexie compat audit + typecheck
npm run dev           # then, in the browser:
#   /?phase=fresh  -> /?phase=reload        OPFS suite incl. durability across reload
#   /compat.html?phase=fresh -> ?phase=reload   IndexedDB fallback + Dexie migration
#   /bench.html                              benchmark
```

## License

MIT
