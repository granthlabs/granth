# Collection

A query that has not run yet — build it up, then execute it with `toArray()`,
`count()` and friends.

## ⚠️ Two easily-confused methods

| Method | Returns |
|---|---|
| `sortBy(keyPath)` | a sorted **array** — `Promise<T[]>`, not a Collection |
| `keys()` | the **index** keys — *not* the primary keys (use `primaryKeys()` for those) |

Both are asserted in the test suite, because getting either wrong fails
*silently* rather than loudly.

## Filtering & ordering

| Method | Returns | Notes |
|---|---|---|
| `or(index)` | `WhereClause` | Union with another condition |
| `filter(fn)` / `and(fn)` | `Collection` | JS predicate, client-side |
| `until(fn, includeStop = false)` | `Collection` | Stop at the first match |
| `limit(n)` / `offset(n)` | `Collection` | |
| `reverse()` | `Collection` | Flip current direction — of the **bound index**, see below |
| `desc()` | `Collection` | Force descending |
| `orderBy(index)` | `Collection` | Chainable ordering |
| `distinct()` | `Collection` | **No-op** — see below |

### Iteration order

A collection iterates its **bound index**: the `orderBy` index if you set one, otherwise the
first index you filtered on, otherwise the primary key. `reverse()` flips *that*. This matters
most for paging — `offset`/`limit` over a different order returns **different rows**, not merely
a different arrangement.

```js
// ordered by age descending, not by id
await db.friends.where('age').above(18).reverse().offset(20).limit(10).toArray();
```

Rows whose key is absent or `null` are **not in the index**, so `orderBy('nickname')` omits
anyone without a nickname — matching IndexedDB, where such records are never added to that
index. The same rule applies to `notEqual`, `noneOf` and `startsWith('')`.

`sortBy(keyPath)` is different: it sorts client-side over whatever the collection returned, so
it keeps rows with no key (they sort last) and works on any keyPath, indexed or not.

### Filter on one index, sort by another

A cursor-based store can only use a single index per query. A SQL query planner can filter on
one index and order by another, so this just works:

```js
await db.issues
  .where('key').anyOf(['a', 'b'])   // filtered by one index
  .orderBy('updated_at')            // ordered by another
  .offset(20).limit(10)
  .toArray();
```

### `distinct()` is a no-op

Dexie needs it because its multiEntry cursor yields one hit per matching array element. Our
multiEntry compiles to an `IN (SELECT ...)` subquery which never duplicates rows. The method
exists so migrated code runs unchanged.

## Reading

| Method | Returns |
|---|---|
| `toArray()` | `Promise<T[]>` |
| `first()` / `last()` | `Promise<T \| undefined>` |
| `count()` | `Promise<number>` |
| `toMap(keyPath?)` | `Promise<Map>` |
| `primaryKeys()` | `Promise<Key[]>` |
| `keys()` | `Promise<IndexKey[]>` — **index** keys |
| `uniqueKeys()` | `Promise<IndexKey[]>` |
| `firstKey()` / `lastKey()` | `Promise<IndexKey>` |
| `sortBy(keyPath)` | `Promise<T[]>` — accepts any keyPath, not just an index |
| `each(fn)` / `eachKey(fn)` / `eachPrimaryKey(fn)` / `eachUniqueKey(fn)` | `Promise<void>` |

`for await (const doc of collection) { ... }` also works.

## Writing

### `delete()` → `Promise<number>`

### `modify(changes)` → `Promise<number>`

Object form compiles to a single `json_patch` UPDATE:

```js
await db.friends.where('age').below(18).modify({ junior: true });
```

Function form matches Dexie — it reads the matching docs, applies the function, and writes them
back in **one atomic batch**:

```js
await db.friends.where('age').below(18).modify((f) => { f.junior = true; });

// delete rows by clearing ctx.value, as in Dexie
await db.friends.where('age').above(99).modify(function (f, ctx) { ctx.value = undefined; });
```

## Performance note

`.filter(fn)` and `.until(fn)` run in JS, so the worker returns **every index match** and
limit/offset apply afterwards. Narrow with an indexed `.where()` first on large tables.
