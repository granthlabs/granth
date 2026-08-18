# Cache-first apps: the Notion pattern

The clearest public case for a browser-side SQL database is Notion's, described
on their engineering blog. It is worth understanding because it includes the
part most write-ups leave out: the rollout initially made things *worse* for
some users.

## What they reported

Notion moved page data into a WASM build of SQLite in the browser, backed by
OPFS, with a single connection owned by one elected context. They measured
roughly a **20% improvement in navigation time**.

The instructive detail is the shape of the win. It moved the **median**
substantially, and on slow devices the **p95 got worse** before they tuned it —
because reading from disk on a low-end machine can be slower than fetching over
a fast network. A local cache is not automatically faster. It is faster *on
average*, and you have to measure the tail.

## Why the topology matters

Their design and granthdb's converge on the same constraints, because the
platform imposes them:

| Constraint | Why | In granthdb |
|---|---|---|
| One connection | OPFS sync access handles are exclusive; two writers corrupt the file | Web Locks election, one writer tab |
| Off the main thread | SQL on the UI thread janks rendering | dedicated Worker |
| No COOP/COEP | those headers break third-party embeds | `opfs-sahpool` VFS needs neither |
| A rebuild path | browsers evict storage | `deleteDatabase()` plus your server |

The multi-tab part is not a nicety. Two tabs writing one SQLite file over OPFS
is a corrupted database, which is why [the leader election](/runtimes) exists
rather than being an optional extra.

## The pattern, concretely

Render from the local database immediately; refresh from the network in the
background; let the UI update itself when the data changes.

```js
db.version(1).stores({ pages: 'id, workspace, updated', meta: 'key' });

// 1. Paint from local data. No spinner if we have anything at all.
const cached = await db.pages.where('workspace').equals(id).orderBy('updated').toArray();
render(cached);

// 2. Refresh in the background, asking only for what changed.
const since = (await db.meta.get('lastSync'))?.value ?? 0;
const fresh = await fetch(`/api/pages?since=${since}`).then((r) => r.json());

// 3. One transaction: either the whole update lands or none of it does.
await db.transaction('rw', [db.pages, db.meta], async () => {
  await db.pages.bulkPut(fresh.pages);
  await db.meta.put({ key: 'lastSync', value: fresh.serverTime });
});
```

The UI does not need step 3 wired to it by hand — `liveQuery` re-runs on change,
including changes made in another tab:

```js
db.pages.where('workspace').equals(id).orderBy('updated')
  .liveQuery()
  .subscribe(render);
```

See [liveQuery](/live-query).

## Do this before you claim it is faster

Notion's own numbers are the argument for measuring rather than assuming:

- **Measure p95 and p99, not the mean.** The mean hides the users you hurt.
- **Test on a slow device**, not your laptop. That is where disk loses to network.
- **Keep the network path warm.** A cache-first app that cannot fall back to the
  network is an app that breaks when storage is evicted — and Safari evicts
  script-writable storage after 7 days without interaction.
- **Ask to persist**: `await navigator.storage.persist()`.
- **Ship a reset.** `deleteDatabase()` behind a "reset local data" control turns
  a corrupted store into a click instead of a support ticket. Corruption happens
  in the field across this whole ecosystem at roughly 0.1–0.2% of users, from
  browser crashes and third-party cleanup tools.

## When this pattern is wrong

- **The data is not yours to cache.** Local storage is not encrypted and the
  user can read it. See [Encryption](/encryption).
- **The data changes constantly for everyone.** A live ticker has nothing to
  cache; you are adding a database to display a websocket.
- **The dataset is tiny.** A few hundred records read once is not worth a WASM
  download on first load.
- **You need server-enforced authorisation per row.** A client-side database
  cannot enforce that, and a user can edit their own file. Enforce it server
  side and treat the local copy as a replica.

Sources: Notion's engineering write-up on their WASM SQLite rollout, and the
measurements in [Security & performance](/security-and-performance).
