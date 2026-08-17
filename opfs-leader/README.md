# opfs-leader

One tab owns the worker. Every tab can call it. Zero dependencies, ~250 lines.

```bash
npm install opfs-leader
```

This is the topology [Notion shipped](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite)
for WASM-SQLite on OPFS, extracted from the database. It does **not** bundle SQLite — it
coordinates whatever your worker owns.

## Why this exists

OPFS sync access handles are **dedicated-worker only** (not main thread, not SharedWorker),
and the fast VFS (`opfs-sahpool`) allows **exactly one connection**. Let two tabs open the
same file and you corrupt it — Notion's first rollout showed users comments attributed to the
wrong person. Web Locks band-aids made it *rarer*; only single-writer ownership eliminated it.

Nothing on npm ships just this layer:

| | ships the topology? |
|---|---|
| `sqlocal` | No — deliberately dropped cross-tab blocking, defers to SQLite locking |
| `@subframe7536/sqlite-wasm` | No — VFS wrapper only |
| `broadcast-channel` | Election only, plus a non-WebLocks fallback with a documented duplicate-leadership bug |
| PowerSync / Zero / Electric | Yes — but you adopt a whole sync platform and a backend |

Election here is `navigator.locks`, which is available everywhere OPFS is. The browser
releases the lock when the tab dies — **that release is the failover.** No heartbeat.

## Use

```js
// any tab
import { createLeaderClient } from 'opfs-leader';

const db = createLeaderClient({
  name: 'app-db',
  worker: () => new Worker(new URL('./db.worker.js', import.meta.url), { type: 'module' }),
});

await db.call('query', 'SELECT * FROM notes WHERE id = ?', [id]);
```

```js
// db.worker.js — constructed ONLY in the elected tab
import { serveInWorker } from 'opfs-leader/worker';

// Plain setup — there is no magic init handler. Register synchronously and pass
// `ready`, so calls arriving during setup are queued instead of dropped.
const ready = openWithSahPoolVfs();
serveInWorker({
  async query(sql, params) { return (await ready).selectObjects(sql, params); },
}, { ready });
```

## The two failure modes, and why they are different errors

```js
try {
  await db.call('insert', row);
} catch (e) {
  if (e instanceof NoLeaderError)   // nobody ACKed — nothing ran. Safe to retry.
  if (e instanceof LeaderLostError) // ACKed, then the leader died. UNKNOWN commit state.
}
```

The leader ACKs a call before running it. That ACK is what makes the distinction possible:
no ACK means no tab took ownership, so a retry cannot double-write. Once ACKed, a dead leader
leaves you unable to know whether the transaction committed (Roy Hashimoto's residual caveat
on the original design). **Keep writes idempotent or verify after a `LeaderLostError`.**

## Racing the cache

```js
import { staleWhileRevalidate, raceFirstWin, hedge } from 'opfs-leader/race';

// default: cache answers immediately, network never touches the critical path
const notes = await staleWhileRevalidate(() => db.call('query', SQL), () => api.get('/notes'));
```

A local cache is **not** automatically faster. Notion's median improved while p95 got *worse*
— old Android phones read disk slower than the network. Firefox reached the same conclusion
independently building RCWN and ended up disabling racing on mobile entirely.

- `staleWhileRevalidate` — **default.** Never lets a slow disk inflate user-visible latency.
- `raceFirstWin` — what Notion shipped. Only when stale data is unacceptable. Costs a network
  request on every read.
- `hedge` — network only if the cache hasn't answered in `delayMs`. Read-heavy idempotent
  reads.

## Non-goals

Not a sync engine: no offline writes, no conflict resolution, no server protocol. If you need
those, adopt PowerSync or Zero rather than growing this. **The local store is a cache or a
replica, never the source of truth** — OPFS gets evicted (Safari's 7-day ITP rule, Chrome's
~100 MB incognito cap, CCleaner deleting it as "Internet Cache"). Always keep a rebuild path.

## Browser support

Chrome 108+, Safari 16.4+, Firefox 111+ — Web Locks is available everywhere OPFS is.
Requires a secure context.

## Test

```bash
npm test
```

Stubs Web Locks and Worker so election, routing, failover and the ACK/retry distinction are
verified in Node. Node's `BroadcastChannel` is real, so the cross-tab messaging is not faked.

## Related

[`granth`](https://www.npmjs.com/package/granth) — a Dexie-shaped database built on this.

## License

MIT
