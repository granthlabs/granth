# Runtimes

A runtime decides **where the SQL executes**. Two ship; you can write your own.

| Runtime | Package | SQL runs | Can use OPFS |
|---|---|---|---|
| `workerRuntime` | `granth-runtime-worker` | in a dedicated Worker, owned by one elected tab | ✅ |
| `inlineRuntime` | `granth-runtime-inline` | on the calling thread | ❌ |

## worker — the default

```js
const db = new Granth('myapp', {
  worker: () => new Worker(new URL('./db.worker.js', import.meta.url), { type: 'module' }),
});
```

`worker` is shorthand for `runtime: workerRuntime({ worker })`. One tab is elected
via Web Locks and owns the database; every other tab routes its calls to it. This
is the only runtime that can use OPFS, because sync access handles are
dedicated-worker-only, and the only one that keeps SQL off the main thread.

## inline — no Worker at all

For strict CSP without `worker-src`, some extension and embedded contexts,
server-side rendering, Node, and tests.

```js
import { inlineRuntime } from 'granth-runtime-inline';
import { createEngine, rpcHandlers } from 'granth-engine';

const db = new Granth('myapp', {
  runtime: inlineRuntime({
    createHandlers: async () => rpcHandlers(() => engine),
  }),
});

await db.runtimeKind(); // 'inline'
```

Two limits, stated rather than hidden:

- **It cannot use OPFS.** Pair it with `indexeddbStorage()` or `memoryStorage()`.
- **SQL runs on the calling thread**, so a slow query blocks rendering.

Cross-tab change notification still works — `BroadcastChannel` is not
worker-only, so only *execution* moves, not the topology. Web Locks still
serialise transactions between inline tabs when available.

## Choosing deliberately

`granthdb` does **not** silently fall back from worker to inline. A worker factory
that cannot build a worker surfaces a real error instead of quietly moving SQL
onto your main thread. If you want inline, ask for it:

```js
const runtime = Granth.isSupported()
  ? workerRuntime({ worker })
  : inlineRuntime({ createHandlers });
```

## Writing one

A runtime is five methods — see [Plugins](./Plugins.md) and the `RuntimePlugin`
contract in `granth-protocol`.
