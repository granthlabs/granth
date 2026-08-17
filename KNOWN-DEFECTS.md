# Known defects — do not publish 0.2.1 until these are resolved

Found by two adversarial reviews. Every item below was **executed**, not reasoned
about. The compat audit walks method *names* only, so it catches none of them.

Ranked. The first three are the ones that lose or corrupt user data.

## 1. A string key hits an INTEGER primary key — including delete (DATA LOSS)

`engine.ts` get/delete/insert/update. `encodeValue` passes a string through and
SQLite's INTEGER-PRIMARY-KEY affinity coerces `'2'` to `2`.

```
seed a,b,c on '++id, name'
get('2')      -> row b        (dexie: undefined)
delete('2')   -> row b GONE   (dexie: no-op)
put({id:'2'}) -> overwrites   (dexie: adds a 4th row)
```

A route param or localStorage value that stayed a string is the everyday path in.
`bulkGet(['2'])` returns `[undefined]` while `get('2')` returns the row — granth
disagreeing with itself is the tell.

**Fix:** bind the key with its JS type, or reject a type mismatch, in
get/delete/insert/update.

## 2. notEqual / noneOf / orderBy / startsWith('') include rows with an ABSENT or null key

`plan.ts` — `notEqual`, `noneOf`, `noneOf([])`, `ORDER BY`, and the empty-prefix
branch emit no index-membership predicate. IndexedDB omits such records from the
index entirely.

```
rows: zoe, adam, {} (absent), {name:null}, carl
notEqual('zoe')   -> [adam, absent, null, carl]   (dexie: [adam, carl])
noneOf([])        -> all 5                        (dexie: [adam, carl, zoe])
orderBy('name')   -> all 5                        (dexie: [adam, carl, zoe])
```

This is the soft-delete query — `where('deletedAt').notEqual(x)` — returning rows
it must not. `range()` already does this correctly for range operators; these
paths were never given the same treatment.

**Fix:** apply the `range()` sentinel/NULL exclusion to all four.

## 3. No implicit index ordering; reverse() reverses the primary key, not the bound index

`plan.ts` emits no `ORDER BY` unless one was asked for, and `reverse()` alone
orders by the primary key. Dexie always iterates the bound index.

```
where('age').above(15).reverse()  -> wrong order entirely
.offset(1).limit(2)               -> DIFFERENT ROWS, not just a different order
toCollection().keys()             -> came back in AGE-index order
```

Forward order is not merely different from Dexie, it is **unspecified** — SQLite
picks whichever index is cheapest, so adding an index silently reorders a user's
list. Paging is the sharp edge: different rows, no error.

**Fix:** always emit `ORDER BY <bound index>, pk`, and make `reverse()` flip that.

## 4. equalsIgnoreCase / startsWithIgnoreCase / anyOfIgnoreCase are ASCII-only

SQLite's `lower()` folds A-Z only, and the needle is lowered in JS (full Unicode)
while the column is lowered in SQL — so it matches only already-lowercase stored
values. `equalsIgnoreCase('ÉCOLE')` misses `ÉCOLE`; same for Cyrillic, Greek,
Å-with-ring. ASCII, Turkish İ and German ß all match Dexie.

The docs call these "do not use the index" — a performance note. The correctness
gap is undocumented.

**Fix:** register a Unicode-aware `lower`, or store a normalised shadow column.

## 5. liveQuery over a Map emits once, then is dead forever

`client/src/index.ts` dedupes with `JSON.stringify(value)`, and
`JSON.stringify(new Map(...))` is `'{}'` for every Map — including the one
`Collection.toMap()` returns. Three rows, add three more, and the subscriber
never hears again. No error. Same class for `Set`.

**Fix:** dedupe on something that distinguishes Maps/Sets, or skip dedupe for
non-plain results.

## 6. multiEntry keys()/uniqueKeys()/eachKey() return the row's OTHER tags

The shadow-table read filters by matching primary keys rather than by the
condition, so every element of every matching row comes back.
`where('tags').equals('a').uniqueKeys()` returns `['a','b']`. `primaryKeys()` and
`count()` on the same collection are correct — only the key accessors leak. A tag
facet count built on this shows tags that do not match.

## 7. sortBy() ignores reverse()

Dexie multiplies by the collection direction; granth hardcodes ascending on both
its indexed and client-side paths. `t.reverse().sortBy('age')` comes back exactly
inverted, silently. Related: `sortBy` puts missing keys FIRST on an indexed
keyPath and LAST on a non-indexed one — the same method, two answers, depending
on whether the field happens to be indexed.

## 8. keys() on a compound index returns [undefined, ...] once .filter() is attached

The client-side branch does a literal property lookup for `'[name+age]'` instead
of reading the tuple. The server-side branch is correct, so attaching a filter
silently changes the result.

## 9. notEqual on a compound index throws

The client special-cases `notEqual` out of the array unwrap, so the raw array is
bound as a parameter. `equals(['a',1])` works on the same index — the asymmetry
is the bug.

## 10. limit() mishandles negative and non-integer values

`Number(plan.limit)` is interpolated into the SQL text. `limit(-1)` returns
**every row** (SQLite reads a negative limit as unlimited) where Dexie returns
none — so a `limit(pageSize - taken)` that underflows dumps the whole table.
`limit(1.7)` and `limit(NaN)` throw SQL errors.

## 11. bulkAdd / bulkPut inside the batch form of transaction() always fails

`api.batch` opens a transaction without setting `inTx`, so the nested bulk helper
issues a second `BEGIN`: "cannot start a transaction within a transaction", zero
rows written. `tx.friends.add(...)` in the same form works, so it reads as bad
data rather than a library bug. `TxTable` exposes both methods publicly.

## 12. prefixUpperBound mishandles a lone low surrogate

The surrogate step-back does not check that a high surrogate precedes it, so for
`'a\uDC00'` it returns a bound BELOW the prefix and `startsWith` matches nothing.

## 13. Lower severity, confirmed

- `update(k, {x: undefined})` keeps the key with the UNDEF sentinel; Dexie deletes
  the property, so `'x' in doc` differs.
- `get(null)` / `get(undefined)` / `get({})` return undefined; Dexie throws.
- `add({id:'abc'})` on a `++id` table throws `datatype mismatch`; Dexie accepts it.
- `orderBy('*tags')` throws; Dexie orders by element.
- `Collection.delete()` with a client-side filter returns the candidate count, not
  rows actually deleted.

## Unverified, neither confirmed nor dismissed

`NoLeaderError` says "safe to retry", but a SLOW (not dead) leader — a frozen
background tab keeps its Web Lock, so no re-election happens — may process the
call after the caller timed out, applying the write twice. A probe attempt did
not reproduce it: both clients shared the fake LockManager, so the follower
elected itself and never took the follower path. Needs a harness that pins one
client as leader while stalling its worker.

## What DID hold up

Ran and matched Dexie exactly: `anyOf` with duplicates/empty/mixed types;
`between` with lo > hi and equal bounds; `until()`; `.filter()` with
limit/offset/count in either order; `offset`/`limit` edge values;
`reverse().reverse()`; cross-type key ordering; the key accessors on ordinary
single-column indexes; compound `equals`; all `modify(fn)` forms; `add`/`put`/
`update` return values; explicit-key-then-auto-increment continuation; Date
primary keys; `where({...})`; `or()`; `inAnyRange`; and liveQuery on plain
results — correct initial emit, correct emit on an in-set change, correctly
silent on an unrelated write.

Also sound under adversarial probing: the chunked bulk-insert id derivation
(exact chunk boundaries, trigger-firing tables, non-contiguous rowids, key `0`
and `''`, duplicate keys within a chunk, mid-chunk rollback), and SQL injection
across every path that becomes an identifier or a JSON path.
