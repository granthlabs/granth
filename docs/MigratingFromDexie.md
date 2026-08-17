# Migrating from Dexie or IndexedDB

Two jobs: your **code** and your **data**.

## 1. Code

The API is matched against the real `dexie` package by a generated audit
(`compat-audit.mjs`) that fails the build on any regression:

| Class | Coverage |
|---|---|
| WhereClause | **18 / 18** |
| Table | 27 / 28 (`defineClass`, deprecated in Dexie itself) |
| Collection | 26 / 28 (`clone`, `raw` — Dexie internals) |
| Dexie | 20 / 26 (middleware, `idbdb` — meaningless without IndexedDB) |

### Run the codemod

```bash
npx granth-codemod ./src
```

It rewrites the imports, `new Dexie(...)` / `extends Dexie`, and the binding
imports; scaffolds a `db.worker.js` if one is missing; and **reports** everything
it cannot safely rewrite instead of guessing. Use `--dry` first.

The manual version is small:

```diff
- import Dexie from 'dexie';
- const db = new Dexie('myapp');
+ import Granth from 'granthdb';
+ const db = new Granth('myapp', {
+   worker: () => new Worker(new URL('./db.worker.js', import.meta.url), { type: 'module' }),
+ });

  db.version(1).stores({ friends: '++id, name, age, *tags' });   // unchanged
```

Your queries, schema strings, hooks and transactions stay as they are.

### Things to check

| Dexie | granth | Action |
|---|---|---|
| `db.transaction('rw', …, async fn)` | ✅ supported | none |
| `Table.hook(...)` | ✅ client-side | a hook can't veto an already-committed write |
| `Collection.modify(fn)` | ✅ atomic batch | none |
| `Collection.distinct()` | no-op | none — we never duplicate rows |
| `upgrade()` callbacks | ➡️ moved | put them in the worker's `upgrades: { 2: fn }` |
| `Dexie.use()` / `unuse()` | ❌ | no middleware layer |
| `db.backendDB()` / `idbdb` | ❌ | there is no IDBDatabase |
| `Dexie.Promise` / PSD zones | ❌ | **plain promises — always `await` your writes** |
| `Date`, `NaN`, `Infinity`, `BigInt` | ✅ preserved | a value codec keeps structured-clone fidelity that plain JSON would lose |

The last one is the only real behavioural trap: Dexie's zones let you fire writes inside a
transaction without awaiting them. Here you must `await`.

## 2. Data

```js
import { suggestSchema, importFromIndexedDB } from 'granth-migrate-idb';

// Read the schema straight out of the old database
const schema = await suggestSchema('my-old-dexie-db');
db.version(1).stores(schema);
await db.open();

const counts = await importFromIndexedDB(db, {
  from: 'my-old-dexie-db',
  onProgress: ({ store, done, total }) => console.log(store, done, '/', total),
});
// -> { friends: 1240, notes: 88 }
```

- `suggestSchema()` derives the `stores({...})` object from the real object stores —
  auto-increment keys, unique, multiEntry and compound indexes.
- `inspectIndexedDB()` returns the schema plus row counts if you want to look first.
- The import **preserves primary keys** and rebuilds every index.
- It is **idempotent** (uses `bulkPut`), so a re-run overwrites rather than duplicating.
- It does **not** delete the source. Verify, then delete it yourself.

Stores with out-of-line keys throw a clear error — granth requires an inline `keyPath`.

## 3. What you gain

- **Filter on one index, order by another** —,
  30 👍, impossible in IndexedDB.
- `toMap()`, `for await` iteration, `clearAll()`,
  `size()`.
- Real SQL indexes and query planning instead of cursor walking.
- Queries run in a worker, off the main thread.
- No "first `toArray()` returns `[]`" ordering trap — queries auto-open.
