---
title: Getting started
---

# Getting started with granthdb

Pick what you're building on and we'll take you straight to the setup for it.

<div class="pick-grid">
  <a class="pick-card" href="./frameworks#react">
    <span class="pick-card__logo" aria-hidden="true">⚛</span>
    <span class="pick-card__name">React</span>
    <span class="pick-card__note">Next.js too — SSR-safe</span>
  </a>
  <a class="pick-card" href="./frameworks#vue">
    <span class="pick-card__logo" aria-hidden="true">▲</span>
    <span class="pick-card__name">Vue</span>
    <span class="pick-card__note">Nuxt too</span>
  </a>
  <a class="pick-card" href="./frameworks#svelte">
    <span class="pick-card__logo" aria-hidden="true">◆</span>
    <span class="pick-card__name">Svelte</span>
    <span class="pick-card__note">No adapter needed</span>
  </a>
  <a class="pick-card" href="./frameworks#angular">
    <span class="pick-card__logo" aria-hidden="true">◈</span>
    <span class="pick-card__name">Angular</span>
    <span class="pick-card__note">No adapter needed</span>
  </a>
</div>

<div class="pick-grid pick-grid--wide">
  <a class="pick-card" href="./tutorial">
    <span class="pick-card__name">Vanilla JS</span>
    <span class="pick-card__note">No framework — start from the tutorial</span>
  </a>
  <a class="pick-card" href="./runtimes">
    <span class="pick-card__name">No Worker</span>
    <span class="pick-card__note">Strict CSP, SSR, Node and tests</span>
  </a>
</div>

Already using Dexie or raw IndexedDB? **[Migrating from Dexie](./migrating-from-dexie)** covers
the codemod, the data import, and every behavioural difference worth knowing.

## The three-minute version

Whatever the framework, the setup is the same three pieces.

**1. Install.**

```bash
npm install granthdb @sqlite.org/sqlite-wasm
```

**2. Declare the database.** The string after each table names the primary key first, then the
fields you want to query by.

```js
// db.js
import Granth from 'granthdb';

export const db = new Granth('myapp', {
  worker: () => new Worker(new URL('./db.worker.js', import.meta.url), { type: 'module' }),
});

db.version(1).stores({
  friends: '++id, name, age, *tags',
});
```

**3. Add the worker.** SQLite runs off the main thread. This file is the whole of it.

```js
// db.worker.js
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { startGranthWorker, opfsStorage, indexeddbStorage, memoryStorage } from 'granthdb/worker';

startGranthWorker({
  sqlite3InitModule,
  filename: '/myapp.sqlite3',
  storage: [opfsStorage(), indexeddbStorage(), memoryStorage()],
});
```

Then query it. No `open()` call — the first query opens the database.

```js
await db.friends.add({ name: 'Ada', age: 36, tags: ['maths'] });
await db.friends.where('age').above(30).toArray();
```

## Where to go next

| | |
|---|---|
| [Tutorial](./tutorial) | The full walkthrough, start to finish |
| [Sandbox](/play/sandbox) | Write real queries against a real database, no install |
| [Showcase](/play/showcase/) | A 5,000-row app you can poke at |
| [Frameworks](./frameworks) | React, Vue, Svelte, Angular, Solid |
| [TanStack Query, RxJS, Zustand](./state-libraries) | Using it with the state library you already have |
| [Replacing localStorage](./replacing-web-storage) | Moving tokens and app state off web storage |

<style scoped>
.pick-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  margin: 28px 0 12px;
}
.pick-grid--wide { grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); margin-top: 0; }

/* The whole card is the target, not the word — and hierarchy comes from weight
   and colour, so the name leads and the note sits a step down the grey ramp. */
.pick-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 20px;
  border: 1px solid var(--g-line-soft);
  border-radius: var(--g-radius-lg);
  background: var(--g-bg-soft);
  text-decoration: none;
  transition: background 120ms ease, border-color 120ms ease, transform 120ms ease;
}
.pick-card:hover {
  background: var(--g-bg-panel);
  border-color: var(--g-accent-dim);
  transform: translateY(-2px);
}
.pick-card__logo { font-size: 26px; line-height: 1; color: var(--g-accent); margin-bottom: 6px; }
.pick-card__name { font-size: var(--g-text-lg); font-weight: 600; color: var(--g-text); }
.pick-card__note { font-size: var(--g-text-sm); color: var(--g-text-3); line-height: 1.5; }
</style>
