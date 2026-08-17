# Table

One table. Reach it as `db.friends` or `db.table('friends')`.

## Properties

| Property | Description |
|---|---|
| `name` | Table name |
| `db` | Owning database |
| `schema` | `{ name, primKey, indexes }` — same shape as Dexie's |

## Reading

| Method | Returns | Notes |
|---|---|---|
| `get(key)` | `Promise<T \| undefined>` | |
| `bulkGet(keys)` | `Promise<(T\|undefined)[]>` | **One round trip.** Order preserved; misses are `undefined` |
| `toArray()` | `Promise<T[]>` | |
| `count()` | `Promise<number>` | |
| `each(fn)` | `Promise<void>` | |
| `toMap(keyPath?)` | `Promise<Map>` | Keyed by primary key, or any keyPath |
| `where(index)` | [`WhereClause`](./WhereClause.md) | |
| `where({a, b})` | [`Collection`](./Collection.md) | Multi-index equality, AND'ed |
| `orderBy(index)` | `Collection` | |
| `filter(fn)` | `Collection` | JS predicate, runs client-side |
| `limit(n)` / `offset(n)` / `reverse()` | `Collection` | |
| `toCollection()` | `Collection` | |

`for await (const doc of db.friends) { ... }` also works.

## Writing

| Method | Returns | Notes |
|---|---|---|
| `add(doc)` | `Promise<Key>` | Throws on duplicate key |
| `put(doc)` | `Promise<Key>` | Upsert (replaces) |
| `update(key, changes)` | `Promise<number>` | **Merge patch** (RFC 7396): nested objects merge, `null` deletes a key |
| `upsert(key, changes)` | `Promise<Key>` | Insert if absent, merge if present |
| `delete(key)` | `Promise<number>` | |
| `clear()` | `Promise<number>` | |
| `bulkAdd(docs)` / `bulkPut(docs)` | `Promise<Key[]>` | One atomic batch, one round trip |
| `bulkUpdate([{key, changes}])` | `Promise<number>` | |
| `bulkDelete(keys)` | `Promise<number[]>` | |

**Batch your writes.** `bulkAdd` is ~200× the throughput of the same rows added one at a time,
because each individual write is its own durable commit.

## Hooks

```js
db.friends.hook('creating', (primKey, obj) => { obj.createdAt = Date.now(); });
db.friends.hook('reading',  (obj) => ({ ...obj, fullName: `${obj.first} ${obj.last}` }));
db.friends.hook('updating', (mods, primKey, obj) => ({ updatedAt: Date.now() }));
db.friends.hook('deleting', (primKey, obj) => audit(obj));
```

Same signatures as Dexie. **Difference:** they run client-side around the RPC, not inside the
same SQLite statement, so a hook cannot veto a write that already committed.

## mapToClass

```js
class Friend { get label() { return `${this.name} (${this.age})`; } }
db.friends.mapToClass(Friend);
(await db.friends.get(1)) instanceof Friend; // true
```
