# Granth

The database. Mirrors [Dexie's `Dexie` class](https://dexie.org/docs/Dexie/Dexie).

```js
import Granth from 'granth';

const db = new Granth('myapp', {
  worker: () => new Worker(new URL('./db.worker.js', import.meta.url), { type: 'module' }),
});
```

## Constructor

`new Granth(name, options)`

| Option | Type | Description |
|---|---|---|
| `worker` | `() => Worker` | Shorthand for the default worker runtime. Called only in the tab elected leader. |
| `runtime` | `RuntimePlugin` | Explicit runtime. Overrides `worker`. See [Runtimes](./Runtimes.md). |
| `timeoutMs` | `number` | How long to wait for a leader before failing. Default `5000`. |

You need **either** `worker` or `runtime`. `worker` is the shorthand almost everyone wants:

```js
const db = new Granth('myapp', {
  worker: () => new Worker(new URL('./db.worker.js', import.meta.url), { type: 'module' }),
});
```

To run without a Worker at all (strict CSP, SSR, Node, tests):

```js
import { inlineRuntime } from '@granth/runtime-inline';
const db = new Granth('myapp', { runtime: inlineRuntime({ createHandlers }) });
```

The constructor is **side-effect free** — it touches no browser API. `new Granth(...)` at module
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
startGranthWorker({ sqlite3InitModule, upgrades: { 2: (engine) => { /* backfill */ } } });
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


### `size()` → `Promise<number>`

Bytes the database occupies on disk.


### `storageKind()` → `Promise<'opfs' | 'indexeddb' | 'memory'>`

Which storage backend actually opened. See [Storage](./Storage.md).

### `runtimeKind()` → `'worker' | 'inline'`

Which runtime connected. See [Runtimes](./Runtimes.md).

### `use(plugin)` → `PluginHandle`

Register an addon. Returns a handle so it can be removed again at runtime.

```js
const handle = db.use({
  name: 'audit',
  setup(ctx) {
    ctx.before(({ op, table, args }) => log(op, table));
    ctx.after(({ op }, result) => { /* return a value to replace the result */ });
    ctx.onDispose(() => log('audit removed'));
  },
});

db.plugins;          // ['audit']
await handle.dispose();
db.plugins;          // []
```

A `before` hook that returns a value short-circuits the call entirely — that is
how a cache or an encryption addon intercepts. See [Plugins](./Plugins.md).

### `plugins` → `string[]`

Names of the registered addons.

### `flush()` → `Promise<void>`

Forces a checkpoint. No-op on OPFS; on the IndexedDB fallback it persists immediately.

### `isOpen()`, `hasBeenClosed()`, `hasFailed()`

### `on(event, fn)` / `once(event, fn)`

Events: `ready`, `versionchange`, `blocked`, `close`.

### `Granth.isSupported()` → `boolean` *(static)*

`false` during SSR and in browsers without Web Locks or a secure context. Safe to call anywhere.

```js
if (!Granth.isSupported()) return <ServerFallback />;
```
