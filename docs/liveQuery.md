# liveQuery

Reactive queries that re-run when the data changes — **including changes made in other tabs**.
Mirrors [Dexie's `liveQuery()`](https://dexie.org/docs/liveQuery()).

```js
const sub = db.liveQuery(() => db.friends.where('age').above(30).toArray())
  .subscribe((rows) => render(rows));

sub.unsubscribe();
```

## Behaviour

- Emits once immediately with the current result.
- Re-runs when a table the querier **actually read** changes. Tables are learned automatically
  on the first run; before that it listens to everything.
- **Emits only when the result actually differs** — a write that doesn't change your result
  produces no re-render.
- Errors go to the observer's `error` callback.

## Options

```js
db.liveQuery(querier, {
  tables: ['friends'],   // skip auto-detection and pin the dependency set
  debounceMs: 50,        // coalesce bursts
});
```

## Framework interop — no adapter needed

The returned object is deliberately dual-shaped:

| Framework | Usage |
|---|---|
| **Svelte** | `$query` directly — `subscribe()` returns an unsubscribe function, which *is* the Svelte store contract |
| **Angular / RxJS** | `from(db.liveQuery(...))` — exposes `Symbol.observable` |
| **React** | `import { useLiveQuery } from 'granth/react'` |
| **Vue** | `import { useLiveQuery } from 'granth/vue'` |
| **Vanilla** | `.subscribe(fn)` |

See [Frameworks](./Frameworks.md) for full examples.

## Manual change events

```js
const off = db.onChange((tables) => console.log('changed:', tables));
off();
```
