# Security & performance

Claims here are either measured or mechanical. Where something is a limitation
rather than a feature, it says so.

## Performance

Measured in Chrome on an M-series Mac over 5,000 documents (~1.6 MB), via
[`examples/playground/bench.html`](https://github.com/sundarshahi/granth/blob/main/examples/playground/bench.html).
Run it yourself — these are one machine's numbers and query times vary ±3× with load.

| Operation | Time | Rate |
|---|---:|---:|
| `bulkAdd` 5,000 docs (one transaction) | 295 ms | ~17,000 rows/s |
| `add` one at a time (durable commit each) | ~13 ms each | ~75 rows/s |
| `count()` whole table | 0.5 ms | |
| indexed `where().equals()` | 2.5 ms | |
| compound index lookup | 1.1 ms | |
| multiEntry lookup | 9 ms | |
| `orderBy().offset(2500).limit(50)` | 1.0 ms | |
| full scan, 5,200 docs | 26 ms | ~199,000 rows/s |
| `bulkGet` 500 keys | 5 ms | ~96,000 keys/s |
| `get()` 500 keys individually | 174 ms | ~2,900 keys/s |

### The one rule that matters

**Batch your writes.** `bulkAdd` is ~200× the throughput of the same rows added
one at a time, because each individual write is its own durable commit. Likewise
`bulkGet` beats a loop of `get()` by ~35× — one round trip instead of 500.

### Why a SQL engine helps, specifically

These are structural differences, not tuning:

- **A query planner.** You can filter on one index and order by *another*. A
  cursor-based store walks a single index per query, so it must fetch and sort in
  JavaScript.
- **Set operations in the engine.** `count()`, range scans, `IN`, `DISTINCT` and
  `LIMIT/OFFSET` execute in SQLite over its own B-trees rather than by iterating
  a cursor and counting in JS. `count()` on 5,200 rows is 0.5 ms.
- **Off the main thread.** Queries run in a dedicated Worker, so a slow scan
  doesn't block rendering. (The inline runtime deliberately gives this up — see
  [Runtimes](./Runtimes.md).)
- **One round trip for bulk reads.** `bulkGet` is a single `IN` query.

### What is *not* faster

- **Single durable writes** cost ~13 ms each regardless. That is the commit, not
  overhead we can tune away. `PRAGMA synchronous = NORMAL` was measured and made
  no meaningful difference, so it is not recommended.
- **Tiny datasets.** For a few hundred key-value reads, IndexedDB — or
  `localStorage` — is simpler and the difference is noise. Don't adopt a WASM
  SQLite build to store a preferences object.
- **First load** pays for the sqlite-wasm download (a few hundred KB). Load it
  off the critical path.
- **A local cache is not automatically faster.** Notion's own rollout made the
  median faster and the p95 *worse*, because slow devices read disk slower than
  the network. Measure on real hardware before assuming a win.

## Security

### What the design gives you

- **No SQL is constructed from user input.** The client builds *serializable
  query plans* — plain data — and the worker compiles them. No SQL strings, no
  functions and no `eval` cross the `postMessage` boundary.
- **Values are always bound parameters**, never interpolated into SQL.
- **Identifiers are quoted and escaped**, and schema keyPaths are validated
  against a strict pattern at parse time, because they become both SQL
  identifiers and JSON paths. `'++id, name\'); DROP TABLE t--'` is rejected as an
  invalid keyPath, and there is a test asserting it.
- **Zero runtime dependencies** in the client and engine (sqlite-wasm is a peer).
  A dependency you don't have cannot be compromised in a supply-chain attack.
- **No network access and no telemetry.** The library never phones home; there is
  nothing to opt out of.
- **Origin-scoped storage.** OPFS is per-origin, invisible to the user, requires
  no permission prompt, and is unreachable from another origin.
- **Secure context required** — HTTPS or `localhost`, enforced by the platform
  for both OPFS and Web Locks.

### What it does NOT give you

Be clear-eyed about this; browser-local storage has hard limits.

- **It is not encrypted at rest.** The SQLite file sits in OPFS in plaintext.
  Anyone with access to the device profile can read it. If you store anything
  sensitive, encrypt the values before they reach the database — an addon via
  `db.use()` with a `before`/`after` hook pair is the natural place.
- **XSS on your origin reads everything.** Any script running on your page has
  the same access your app does. Browser storage is not a security boundary
  against code you have already executed.
- **It is not a permissions system.** There are no row-level rules; a client-side
  database cannot enforce authorisation. Enforce it on the server.
- **It is not durable.** Safari evicts script-writable storage after 7 days
  without site interaction; cleanup tools delete OPFS as "Internet Cache";
  Chrome's incognito mode caps it. Call `navigator.storage.persist()` and
  **always keep a rebuild-from-server path**.
- **It is not tamper-proof.** A user can edit their own local database. Never
  trust it as the source of truth for anything that matters — validate on the
  server.

### Practical checklist

```js
await navigator.storage.persist();              // ask not to be evicted
const { quota, usage } = await navigator.storage.estimate();
const bytes = await db.size();                  // what we actually occupy
```

- Treat the local database as a **cache or replica**, never the source of truth.
- Encrypt sensitive values yourself, in an addon, before they are written.
- Keep a rebuild path and exercise it — corruption happens in the field at
  roughly 0.1–0.2% of users across this whole ecosystem, from browser crashes and
  third-party cleanup software.
- Ship `deleteDatabase()` behind a "reset local data" affordance so a corrupted
  store is recoverable by the user rather than a support ticket.
