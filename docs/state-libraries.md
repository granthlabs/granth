# TanStack Query, RxJS, Zustand and friends

The goal is that granthdb needs **no adapter**. A live query is already an
observable, already a Svelte store, and already exposes `.unsubscribe()`. Three
whole ecosystems work with no glue at all.

The two that do need a few lines are the ones whose libraries want something a
plain observable is not: TanStack Query owns its own cache and wants to be *told*
to refetch, and Zustand wants a setter called.

Every example on this page is executed by
[`test-integrations.mjs`](https://github.com/granthlabs/granthlabs.github.io/blob/main/examples/playground/test-integrations.mjs)
against the real `rxjs`, `zustand` and `@tanstack/query-core` packages. A claim
nobody ran is just a comment.

## Works with nothing at all

### RxJS, Angular

`liveQuery()` implements `Symbol.observable`, so `from()` consumes it directly:

```js
import { from } from 'rxjs';
import { map } from 'rxjs/operators';

const friends$ = from(db.liveQuery(() => db.friends.orderBy('name').toArray()));

friends$.pipe(map((rows) => rows.length)).subscribe(setCount);
```

In Angular this means `friends$ | async` in a template, with no service wrapper.
It re-emits on every change — including writes from **another tab**.

### Svelte

`subscribe()` returns its own unsubscribe function, which is exactly the Svelte
store contract. Use `$` directly:

```svelte
<script>
  import { db } from './db.js';
  const friends = db.liveQuery(() => db.friends.toArray());
</script>

{#each $friends ?? [] as f}
  <li>{f.name}</li>
{/each}
```

### React, Vue

First-party bindings: [`granth-react`](/frameworks#react) and
[`granth-vue`](/frameworks#vue).

## TanStack Query

Do **not** replace TanStack's cache — drive its invalidation. It keeps retries,
suspense, devtools and cache lifetime; granthdb tells it when the rows changed.

```js
import { syncQueryKey, granthQuery } from './integrations.js';

// staleTime: Infinity, because local data is not network-stale. Freshness comes
// from invalidation below, not from a timer.
const friendsQuery = granthQuery(db, ['friends'], () => db.friends.toArray());

function Friends() {
  const { data } = useQuery(friendsQuery);

  useEffect(
    () => syncQueryKey(db, queryClient, ['friends'], () => db.friends.toArray()),
    []
  );

  return <List rows={data ?? []} />;
}
```

`syncQueryKey` returns an unsubscribe, so returning it from `useEffect` is all
the cleanup you need.

Why invalidate instead of writing straight into the cache? Because `setQueryData`
skips TanStack's own bookkeeping — no `dataUpdatedAt`, no observers notified in
the normal path, no devtools trace. Invalidation keeps one owner of the cache.

## Zustand

```js
import { bindToStore } from './integrations.js';

export const useFriends = create((set) => {
  bindToStore(db, () => db.friends.toArray(), (friends) => set({ friends }));
  return { friends: [] };
});
```

`bindToStore` returns an unsubscribe. Call it if the store is ever torn down —
otherwise a live query keeps running against a store nobody reads.

## Redux, or anything with a dispatch

```js
import { toDispatch } from './integrations.js';

toDispatch(db, store.dispatch, () => db.friends.toArray(), 'friends/loaded');
// dispatches { type: 'friends/loaded', payload: rows } on every change,
// and { type: 'friends/loaded/error', error: true } if the query throws.
```

## Which approach to pick

| You already use | Do this |
|---|---|
| RxJS / Angular | `from(db.liveQuery(...))` — no glue |
| Svelte | `$store` on the live query — no glue |
| React / Vue | `granth-react` / `granth-vue` |
| TanStack Query | `granthQuery` + `syncQueryKey` |
| Zustand | `bindToStore` |
| Redux / Pinia / custom | `toDispatch`, or subscribe yourself |
| Nothing | `db.liveQuery(...).subscribe(render)` |

## Copy these, don't depend on them

`integrations.js` is about sixty lines and lives in the examples folder on
purpose. It is not published as a package, because a dependency whose entire
body is `subscribe` plus one callback is a maintenance burden for you and a
supply-chain surface for everyone. Copy the four functions you need.

## The one rule

Every helper here returns an **unsubscribe function**. Call it when the
component, store or effect goes away. A live query holds a subscription to table
changes, and one that outlives its consumer is a leak that also does pointless
work on every write.
