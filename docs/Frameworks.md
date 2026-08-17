# Frameworks & bundlers

granth is plain ESM with no framework coupling. The core works anywhere; only React and Vue get
a (tiny, optional) binding, because they have no store contract.

## The one universal requirement

Your bundler must be able to resolve a worker URL:

```js
worker: () => new Worker(new URL('./db.worker.js', import.meta.url), { type: 'module' })
```

Vite, webpack 5, Rollup, Parcel 2, esbuild and Next.js all understand this form natively.

---

## React / Next.js

```jsx
// db.js
import Granth from 'granth';
export const db = new Granth('myapp', {
  worker: () => new Worker(new URL('./db.worker.js', import.meta.url), { type: 'module' }),
});
db.version(1).stores({ friends: '++id, name, age, *tags' });

// Friends.jsx
import { useLiveQuery, useIsSupported } from '@granth/react';
import { db } from './db';

export function Friends() {
  const supported = useIsSupported();          // false during SSR — no hydration mismatch
  const friends = useLiveQuery(db, () => db.friends.orderBy('name').toArray(), [], []);
  if (!supported) return <p>Loading…</p>;
  return <ul>{friends.map((f) => <li key={f.id}>{f.name}</li>)}</ul>;
}
```

Prefer the Dexie call shape? Bind it once:

```js
export const useLive = createLiveQueryHook(db);
// const friends = useLive(() => db.friends.toArray(), [], []);
```

**SSR is safe.** `new Granth(...)` at module scope touches no browser API — it only connects when
you first query. Server renders return the `initialValue`.

## Angular

No adapter needed — `liveQuery` implements `Symbol.observable`:

```ts
import { from } from 'rxjs';
import { db } from './db';

@Component({ /* ... */ })
export class FriendsComponent {
  friends$ = from(db.liveQuery(() => db.friends.orderBy('name').toArray()));
}
```

```html
<li *ngFor="let f of friends$ | async">{{ f.name }}</li>
```

## Svelte / SvelteKit

No adapter needed — `subscribe()` returns an unsubscribe function, which *is* the Svelte store
contract, so it works with `$`:

```svelte
<script>
  import { db } from './db';
  const friends = db.liveQuery(() => db.friends.orderBy('name').toArray());
</script>

{#each $friends ?? [] as f}<li>{f.name}</li>{/each}
```

Under SvelteKit SSR, guard with `browser` from `$app/environment` before querying.

## Vue / Nuxt

```vue
<script setup>
import { useLiveQuery } from '@granth/vue';
import { db } from './db';

const { data: friends } = useLiveQuery(db, () => db.friends.orderBy('name').toArray(), {
  initialValue: [],
});
</script>

<template><li v-for="f in friends" :key="f.id">{{ f.name }}</li></template>
```

Unsubscribes automatically with the component's effect scope.

## Solid, Qwik, Lit, Alpine, vanilla

Use `subscribe` directly:

```js
const stop = db.liveQuery(() => db.friends.toArray()).subscribe(render);
// later: stop();
```

## No bundler (`<script type="module">`)

```html
<script type="module">
  import Granth from 'https://esm.sh/granth';
  const db = new Granth('myapp', {
    worker: () => new Worker('/db.worker.js', { type: 'module' }), // a real URL
  });
  db.version(1).stores({ friends: '++id, name' });
</script>
```

`db.worker.js` must be served from your origin and import sqlite-wasm from a CDN.

---

## Bundler notes

### Vite

```js
// vite.config.js
export default {
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] }, // esbuild mangles its wasm loading
  worker: { format: 'es' },
};
```

### webpack 5

Works out of the box. Ensure `experiments.asyncWebAssembly` if you inline the wasm.

### Next.js

Put the worker file under your app directory and use the `new URL(...)` form. Keep all database
access in client components (`'use client'`) or effects.

### Angular CLI

Add the worker with `ng generate web-worker`, or reference it with `new URL(...)` — Angular 16+
uses esbuild and handles it.

## Environments without a Worker

Strict CSP without `worker-src`, some extension and embedded contexts, SSR and
Node can all run granth — on the inline runtime, paired with a non-OPFS backend.

```js
import { Granth } from 'granth';
import { inlineRuntime } from '@granth/runtime-inline';

const db = new Granth('myapp', { runtime: inlineRuntime({ createHandlers }) });
```

SQL then runs on the calling thread and OPFS is unavailable. See
[Runtimes](./Runtimes.md).

## Requirements everywhere

- **Secure context** — HTTPS or `localhost`. OPFS and Web Locks both require it.
- Chrome 108+, Safari 16.4+, Firefox 111+.
- **No COOP/COEP headers needed.**
