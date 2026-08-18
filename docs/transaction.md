# Transaction

Two forms. Both are atomic; they differ in whether the callback can read.

## Interactive — Dexie-compatible

```js
await db.transaction('rw', db.friends, db.notes, async () => {
  const n = await db.friends.count();      // a READ inside the transaction
  await db.notes.add({ owner: `friend-${n}` });
});
```

Same signature as [Dexie's `transaction()`](https://dexie.org/docs/Dexie/Dexie.transaction()):
mode `'r'` or `'rw'`, the tables, then an async callback. Throwing rolls the whole thing back.

**Isolation.** The transaction holds an **exclusive cross-tab Web Lock** plus a real SQLite
transaction for its duration. Ordinary calls take a *shared* lock, which is what stops another
tab's writes landing inside your transaction. Nesting is allowed and joins the outer transaction
(SQLite has a single write transaction).

## Batch — the fast path

When you don't need to read, this is one round trip instead of several:

```js
await db.transaction((tx) => {
  tx.friends.add({ name: 'eve', age: 22 });
  tx.notes.add({ owner: 'eve' });
});
```

The callback is **synchronous** and *records* operations, which are shipped as a single atomic
batch. Passing an async callback throws a clear error telling you to use the interactive form.

Returns an array of each operation's result.

## Which to use

| | Interactive | Batch |
|---|---|---|
| Can read | ✅ | ❌ |
| Round trips | one per statement | **one total** |
| Holds a cross-tab lock | ✅ exclusive | no |
| Dexie-compatible signature | ✅ | — |

Reach for the batch form for known write sets (imports, bulk edits, "save this form"), and the
interactive form when a later write depends on an earlier read.

## Durability caveat

If the leader tab dies mid-transaction, SQLite rolls back automatically — the connection died
with it. If a *follower* tab dies after its call was acknowledged, the commit state is unknown;
you get a `LeaderLostError`. See [Errors](./errors).
