# Plugins

Everything swappable is a plugin. `granth-protocol` holds the contracts — types
only, zero runtime, zero dependencies — so backends and bindings never import each
other or the client.

Three extension points, deliberately no more:

| Contract | Decides | Ships |
|---|---|---|
| `StoragePlugin` | **where the bytes live** | `opfs` · `indexeddb` · `memory` |
| `RuntimePlugin` | **where the SQL executes** | `worker` · `inline` |
| addon via `db.use()` | everything else | *(yours)* |

## Addons

```js
const handle = db.use({
  name: 'audit',
  setup(ctx) {
    ctx.before(({ op, table, args }) => {
      console.log(op, table);          // return a value to SHORT-CIRCUIT the call
    });
    ctx.after(({ op }, result) => {
      // return a value to replace the result
    });
    ctx.onDispose(() => console.log('removed'));
  },
});

db.plugins;             // ['audit']
await handle.dispose(); // add, remove, expand
db.plugins;             // []
```

`before` returning a value skips the round trip entirely — that is how a cache
addon answers from memory. `after` returning a value replaces the result — that is
how a decryption addon transforms rows on the way out.

`ctx.registerStorage()` and `ctx.registerRuntime()` let an addon contribute a
backend, so a plugin can ship its own storage without changing the client.

## StoragePlugin

```ts
interface StoragePlugin {
  readonly name: string;
  isAvailable(sqlite3: unknown): Promise<boolean> | boolean;
  open(opts: StorageOpenOptions): Promise<StorageHandle>;
}

interface StorageHandle {
  readonly kind: string;
  readonly adapter: Adapter;   // { all, exec, run, createFunction? }
  markDirty(): void;           // after every write; no-op for in-place backends
  flush(): Promise<void>;      // persist now
  destroy(): Promise<void>;    // not recoverable
}
```

Backends are passed to the worker entry as an **ordered list**. The first
available one wins and an `open()` failure falls through, because availability is
a prediction and opening is the proof.

`createFunction(name, fn)` is optional but worth implementing: it is how granth
registers Unicode case folding for `equalsIgnoreCase` and friends. An adapter
without it fails loudly on those three operators (`no such function:
granth_lower`) rather than falling back to SQLite's ASCII-only `lower()` and
quietly returning too few rows.

## RuntimePlugin

```ts
interface RuntimePlugin {
  readonly name: string;
  isAvailable(): boolean;
  connect(opts: { name: string; timeoutMs?: number }): RuntimeConnection;
}

interface RuntimeConnection {
  call<T>(method: string, ...args: unknown[]): Promise<T>;
  close(): void;
  onRemoteChange(fn: (tables: string[]) => void): () => void;
  broadcastChange(tables: string[]): void;
  withLock<T>(mode: 'shared' | 'exclusive', fn: () => Promise<T>): Promise<T>;
}
```

`withLock` is what makes transaction isolation real: ordinary calls take a shared
lock, `transaction()` takes an exclusive one, so another tab's writes cannot land
inside your open transaction. A single-context runtime may no-op it.

## Packages

| Package | Role |
|---|---|
| `granthdb` | the client — what you import |
| `granth-protocol` | contracts, types only |
| `granth-engine` | schema, planner, SQL compiler, value codec |
| `granth-storage-opfs` · `-indexeddb` · `-memory` | storage backends |
| `granth-runtime-worker` · `-inline` | runtimes |
| `granth-react` · `granth-vue` | framework bindings |
| `granth-migrate-idb` | import an existing IndexedDB/Dexie database |
| `opfs-leader` | the multi-tab election, usable standalone |
