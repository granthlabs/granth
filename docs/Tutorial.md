# Tutorial

## 1. Install

```bash
npm install granth @sqlite.org/sqlite-wasm
```

## 2. Create the worker file

This is the whole file. It runs only in the tab elected leader.

```js
// src/db.worker.js
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { startGranthWorker } from 'granth/worker';

startGranthWorker({ sqlite3InitModule, filename: '/myapp.sqlite3' });
```

## 3. Declare the database

```js
// src/db.js
import Granth from 'granth';

export const db = new Granth('myapp', {
  worker: () => new Worker(new URL('./db.worker.js', import.meta.url), { type: 'module' }),
});

db.version(1).stores({
  friends: '++id, name, age, *tags, [name+age]',
  notes:   '++id, owner, created',
});
```

Schema syntax is identical to Dexie: `++` auto key, `&` unique, `*` multiEntry, `[a+b]`
compound. Only **indexed** fields go in the string — everything else is still stored.

## 4. Use it

```js
import { db } from './db';

await db.friends.add({ name: 'ada', age: 36, tags: ['math'] });

await db.friends.get(1);
await db.friends.where('age').above(30).toArray();
await db.friends.where('tags').equals('math').toArray();
await db.friends.where('name').startsWith('a').orderBy('age').limit(10).toArray();
await db.friends.where('age').below(18).modify({ junior: true });
```

You never have to call `open()` — the first query does it.

## 5. React to changes

```js
const stop = db.liveQuery(() => db.friends.orderBy('name').toArray())
  .subscribe((friends) => render(friends));
```

It re-runs on changes from **any tab**, and only emits when the result actually differs.
See [Frameworks](./Frameworks.md) for React/Vue/Angular/Svelte.

## 6. Evolve the schema

```js
db.version(2).stores({ friends: '++id, name, age, city, *tags, [name+age]' });
```

Versions are cumulative — declare only what changed. Need to transform existing rows? Do it in
the worker, because a function cannot cross into it:

```js
startGranthWorker({
  sqlite3InitModule,
  upgrades: {
    2: (engine) => {
      for (const f of engine.query('friends', { or: [] }, 'docs')) {
        if (!f.city) engine.update('friends', f.id, { city: 'unknown' });
      }
    },
  },
});
```

## 7. Before you ship

- `await navigator.storage.persist()` — ask not to be evicted.
- Keep a **rebuild-from-server path**. Browser storage is a cache, not a source of truth.
- **Batch writes**: `bulkAdd` is ~200× the throughput of one-at-a-time.
- Read [Storage](./Storage.md) for the eviction and durability rules.
