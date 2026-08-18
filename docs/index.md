---
layout: home
hero:
  name: granthdb
  text: SQLite in the browser
  tagline: A Dexie-compatible API over SQLite/WASM on OPFS. Real indexes, a real query planner, off the main thread — and it runs without a Worker when it has to.
  actions:
    - theme: brand
      text: Get started
      link: /tutorial
    - theme: alt
      text: Migrating from Dexie
      link: /migrating-from-dexie
    - theme: alt
      text: GitHub
      link: https://github.com/granthlabs/granthlabs.github.io
---

<div class="home-body">

## From nothing to a working query

```js
import { Granth } from 'granthdb';

const db = new Granth('myapp', {
  worker: () => new Worker(new URL('./db.worker.js', import.meta.url), { type: 'module' }),
});

db.version(1).stores({ friends: '++id, name, age, *tags' });

await db.friends.add({ name: 'Ada', age: 36, tags: ['math', 'engines'] });

// Filter on one index, order by ANOTHER — one SQL statement, no JS sort.
const grownups = await db.friends
  .where('age').above(18)
  .orderBy('name')
  .toArray();
```

If you have written Dexie, you have already written this. That is the point: the
API is the same, and what changed is underneath it.

## What is actually different underneath

|  | IndexedDB | granthdb |
|---|---|---|
| Query engine | one index per query, cursor-walked | SQLite's planner |
| Filter on A, sort by B | fetch and sort in JS | one statement |
| `count()` on 5,200 rows | iterate a cursor | 0.5 ms |
| Bulk read of 500 keys | 500 round trips | one `IN` query, 5 ms |
| Where it runs | your main thread | a dedicated Worker |
| Multi-tab writes | last writer wins | one elected writer |

Numbers are measured on one machine and vary; run
[`bench.html`](https://github.com/granthlabs/granthlabs.github.io/blob/main/examples/playground/bench.html)
on yours.

## Honest limits

A local database is a cache with opinions, not a source of truth. Before you
adopt this, read [Security & performance](/security-and-performance) — it is
explicit about what this does **not** give you: it is not encrypted at rest, XSS
on your origin reads everything, Safari evicts script-writable storage after 7
days of no interaction, and a user can edit their own local file. Always keep a
rebuild-from-server path.

## Coming from Dexie

```bash
npx granth-codemod ./src
```

It rewrites imports, `new Dexie(...)` and `extends Dexie`, and **reports rather
than guesses** at anything it cannot safely transform. Then
[import your existing IndexedDB data](/migrating-from-dexie) — schema inference
included, so you are not retyping `stores()` by hand.

</div>
