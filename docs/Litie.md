# Litie

The database. Mirrors [Dexie's `Dexie` class](https://dexie.org/docs/Dexie/Dexie).

```js
import Litie from 'litie';

const db = new Litie('myapp', {
  worker: () => new Worker(new URL('./db.worker.js', import.meta.url), { type: 'module' }),
});
```

## Constructor

`new Litie(name, options)`

| Option | Type | Description |
|---|---|---|
| `worker` | `() => Worker` | **Required.** Factory for the dedicated worker. Called only in the tab elected leader. |
| `timeoutMs` | `number` | How long to wait for a leader before failing. Default `5000`. |

The constructor is **side-effect free** — it touches no browser API. `new Litie(...)` at module
scope is safe under SSR (Next.js, Nuxt, Angular Universal); nothing happens until you use it.

## Properties

| Property | Type | Description |
|---|---|---|
| `name` | `string` | Database name |
| `verno` | `number` | Current version number |
| `tables` | `Table[]` | All declared tables |

## Methods

### `version(n).stores({...})`

Declares the schema for version `n`. **Cumulative**, exactly like Dexie: later versions declare
only what changed, and unchanged stores carry over. `null` deletes a store.

```js
db.version(1).stores({ friends: '++id, name, age, *tags' });
db.version(2).stores({ friends: '++id, name, age, city, *tags' }); // adds `city`
db.version(3).stores({ oldTable: null });                          // drops it
```

Changing a schema **without** bumping the version throws a clear error rather than being
silently ignored. Data transforms go in your worker file (see [Storage](./Storage.md)), because
a function cannot cross into a worker:

```js
startLitieWorker({ sqlite3InitModule, upgrades: { 2: (engine) => { /* backfill */ } } });
```

### `open()` → `Promise<OpenResult>`

Runs migrations. Idempotent and safe to call from every tab. **You rarely need it** — any query
auto-opens first.

Resolves to `{ version, from, migrated, schema }`.

### `table(name)` → `Table`

Also available as a property: `db.friends` ≡ `db.table('friends')`.

### `transaction(...)`

Two forms — see [Transaction](./Transaction.md).

### `liveQuery(querier, opts)` → `Observable`

See [liveQuery](./liveQuery.md).

### `close()`, `delete()` / `deleteDatabase()`

`close()` flushes pending writes first. `delete()` destroys the database file; not recoverable.

### `clearAll()` → `Promise<string[]>`

Empties every table without dropping the schema. Returns the table names cleared.
*(Dexie has no equivalent — [dexie#1571](https://github.com/dexie/Dexie.js/issues/1571).)*

### `size()` → `Promise<number>`

Bytes the database occupies on disk.
*(Dexie has no equivalent — [dexie#689](https://github.com/dexie/Dexie.js/issues/689).)*

### `storageKind()` → `Promise<'opfs' | 'indexeddb'>`

Which backend the worker actually got. See [Storage](./Storage.md).

### `flush()` → `Promise<void>`

Forces a checkpoint. No-op on OPFS; on the IndexedDB fallback it persists immediately.

### `isOpen()`, `hasBeenClosed()`, `hasFailed()`

### `on(event, fn)` / `once(event, fn)`

Events: `ready`, `versionchange`, `blocked`, `close`.

### `Litie.isSupported()` → `boolean` *(static)*

`false` during SSR and in browsers without Web Locks or a secure context. Safe to call anywhere.

```js
if (!Litie.isSupported()) return <ServerFallback />;
```
