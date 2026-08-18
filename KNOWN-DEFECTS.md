# Defects found by adversarial review — status

Two adversarial reviews found 19 confirmed defects that a fully green test suite
had never seen. Every one was **executed**, not reasoned about.

They were invisible for a structural reason: `test-compat-audit.mjs` walks method
*names*, so a method that exists and returns the wrong answer passes it. Nothing
compared granth's **answers** to Dexie's.

That gap is now closed by **`packages/core/client/test-dexie-parity.mjs`**, which
runs the same script against the real `dexie` package and against granth and
diffs the results. It reproduced 27 disagreements before these fixes and reports
0 after, with 5 divergences marked `allow:` and justified below. It runs in `npm
test` and in CI, and a stale `allow:` — one that no longer differs — fails the
run, so the exemptions cannot rot into cover for the next regression.

## Fixed

Ranked as they were found. The first three lost or corrupted data.

**1. A string key hit an INTEGER primary key, including delete — DATA LOSS.**
SQLite's INTEGER-PRIMARY-KEY affinity coerced `'2'` to `2`, so `get('2')`
returned row 2 and `delete('2')` destroyed it. IndexedDB keys are typed and a
lookup by `'2'` simply misses. Keys now bind with their JS type: a key that
cannot belong to the store is a miss on reads and deletes (as in Dexie) and a
named error on writes. `bulkGet` and `get` agreed on nothing before; that
disagreement was the tell.

**2. `notEqual` / `noneOf` / `orderBy` / `startsWith('')` returned rows with no
key.** None emitted an index-membership predicate, so the soft-delete query
`where('deletedAt').notEqual(x)` returned rows that had never been deleted.
`range()` already did this correctly; those four paths were never given the same
treatment. Now a shared `presence()` covers all of them, and all components of a
compound index rather than just the first.

**3. No implicit index ordering; `reverse()` reversed the primary key.** Forward
order was not merely different from Dexie, it was *unspecified* — SQLite picked
whichever index was cheapest, so adding an unrelated index could silently reorder
a user's list. Paging was the sharp edge: `.offset(1).limit(2)` returned
**different rows**, not a different arrangement. Now always `ORDER BY <bound
index>, pk`, with `reverse()` flipping that.

**4. `equalsIgnoreCase` and friends were ASCII-only.** SQLite's `lower()` folds
`A-Z`; the needle was folded in JS with full Unicode. `equalsIgnoreCase('ÉCOLE')`
missed `ÉCOLE`, and every non-English search box under-matched in silence. A
Unicode `granth_lower` is now registered through a new optional `Adapter.
createFunction`; the operators emit it unconditionally, so an adapter without it
fails loudly instead of quietly returning too few rows.

**5. `liveQuery` over a Map emitted once, then was dead forever.** The dedupe key
was `JSON.stringify`, and every Map stringifies to `'{}'` — including the one
`toMap()` returns. Two documented features combining into a UI that stops
updating, with no error.

**6. multiEntry `keys()`/`uniqueKeys()`/`eachKey()` returned the row's OTHER
elements.** The shadow read filtered by matching primary keys instead of by the
condition, so `where('tags').equals('a').uniqueKeys()` answered `['a','b']`.
`count()` and `primaryKeys()` on the same collection were right, which is what
made it look like bad data.

**7. `sortBy()` ignored `reverse()`.** It also placed missing keys first on an
indexed keyPath and last on a non-indexed one — one method, two behaviours, from
routing the indexed case through `ORDER BY`. `sortBy` is now client-side
throughout, as in Dexie.

**8. Compound `keys()` broke once a `.filter()` was attached.** The client-side
branch read `'[name+age]'` as a literal property. Attaching a filter silently
changed the answer.

**9. `notEqual` on a compound index threw.** The client excluded `notEqual` from
the array unwrap, so the tuple bound as one parameter — while `equals` on the
same index worked.

**10. `limit()` mishandled negative and non-integer values.** `limit(-1)` returned
**every row** (SQLite reads a negative limit as unlimited) where Dexie returns
none, so a `limit(pageSize - taken)` that underflowed dumped the whole table.
`limit(1.7)` and `limit(NaN)` were SQL errors.

**11. `bulkAdd`/`bulkPut` inside the batch form of `transaction()` always failed.**
`batch()` opened a transaction without setting `inTx`, so the nested bulk helper
issued a second `BEGIN` and wrote nothing. `tx.friends.add()` in the same form
worked, so it read as bad data rather than a library bug. All three call sites
now share one `inTransaction()` helper, which is the only thing that touches
`inTx`.

**12. `bulkAdd`/`bulkPut` returned the wrong shape.** Found by the new parity
suite, not by either review: Dexie resolves to the **last** key and to every key
only with `{ allKeys: true }`. Returning the array unconditionally meant
`const id = await t.bulkAdd(xs)` silently handed back an array.

**13. Smaller confirmed items.** `update(k, {x: undefined})` kept the key holding
an invisible sentinel instead of deleting the property (patches now encode
`undefined` as RFC 7396 removal, while stored documents keep it — they mean
different things). `get(null)` / `get({})` returned `undefined` instead of
rejecting.

## Divergences that stand, and why

- **A lone surrogate can be stored but not matched.** It round-trips exactly, but
  `json_extract` decodes our JSON escape to WTF-8 (`ED B0 80`) while the driver
  binds the same string as U+FFFD (`EF BF BD`), so the stored key sorts below its
  own lower bound. Fixing it would mean mangling the value on write — losing the
  round-trip Dexie preserves. It fails **closed**: no rows, never wrong rows.
  This one was diagnosed wrong twice before anyone read the actual bytes; the
  recorded cause (`prefixUpperBound`'s surrogate step-back) was correct code.

- **`sortBy` with missing keys.** Dexie's comparator returns 0 whenever either
  side is `undefined`, making it non-transitive: verified, the same code leaves
  `[3, undefined, 1]` **unsorted** and sorts `[z, undefined, a]` with `undefined`
  first. granth sorts transitively with `undefined` last. Non-transitivity cannot
  be replicated in general — the output depends on the sort algorithm's internals.

- **`get(null)` / `get({})`** — both reject; only the message text differs.

- **`add({id: 'abc'})` on a `++id` table** throws where Dexie accepts it. An
  auto-increment key is a SQLite rowid alias and can only be an integer. The error
  now names the table, the key and the fix instead of surfacing as
  `datatype mismatch`.

## Confirmed and fixed: the slow-leader double-apply

`NoLeaderError` documented itself as "safe to retry", reasoning that a call nobody
acknowledged was a call nobody owned. That reasoning holds when there is genuinely no
leader. It did **not** hold for a leader that was merely slow: a frozen background tab
keeps its Web Lock, so nothing re-elects, and the browser QUEUES channel messages for it
rather than dropping them. The caller timed out, retried exactly as the error told it to,
and the thawing leader then ran both copies.

The earlier probe failed to reproduce this for a harness reason worth recording: both
clients shared one fake `LockManager`, so the follower elected **itself** and never took
the follower path at all. `packages/opfs-leader/test-slow-leader.mjs` pins the leader by
having it hold the lock forever and stalls only its channel delivery — which is what a
frozen tab actually is — and asserts up front that the follower really is routing through
the leader, so it cannot pass for the wrong reason again. It reported the write applied
**2×** before the fix and **1×** after.

**Fix:** every call carries a deadline, and a leader that reads a call after the caller
stopped waiting refuses to run it and replies with the same retryable error. The leader's
cutoff is set slightly earlier than the caller's so an accepted call always has room for
its ACK to arrive — otherwise the two decisions race and a call could be accepted while
being reported un-accepted. The caller also yields one task before declaring a timeout, so
an ACK already queued behind the timer is not missed when the tab itself was frozen.

A briefly-stalled leader still serves its calls normally; the fence only refuses calls
nobody is waiting for any more.

## Confirmed and fixed: multiEntry writes cost a full scan, per row

Every published figure was measured at 5,000 rows, which is small enough that
nothing has to be right. Pushing to 100,000 in a real browser found this:
deleting 10,000 rows took **41.5 seconds**. The same table with the multiEntry
index removed did the equivalent work in 332 ms.

A multiEntry index is materialised into a shadow table kept in step by triggers.
The cost was in the trigger body, and the reason is a SQLite rule rather than a
mistake in the SQL: **SQLite does not use an index for the WHERE clause of a
DELETE inside a trigger.** The bytecode is unambiguous — run standalone,
`DELETE FROM shadow WHERE k = ?` compiles to `SeekGE` on the index; run as
`AFTER DELETE ... DELETE FROM shadow WHERE k = old.id` it compiles to `Rewind` +
`Next` over the table, with the index opened only for writing. It is also why
SQLite *rejects* `INDEXED BY` in a trigger body: there is no index choice to
constrain. So every row written scanned the whole shadow table, and the cost grew
linearly with it — measured 423 ms / 1,281 / 3,076 / 7,036 / 14,779 for the same
5,000 deletes against shadow tables of 5k / 10k / 20k / 40k / 80k rows.

Three fixes that seemed obvious did nothing, and each is worth not retrying:
adding the index (it already existed and was ignored), making the shadow
`WITHOUT ROWID` so the key *is* the table, and pushing the search into a
subquery so the DELETE matches on rowid. All three still produced `Rewind`.

**Fix:** filling the shadow stays in triggers — an `INSERT..SELECT json_each()`
has no WHERE to plan — but emptying it moved into the engine's write paths as
one set-based statement, where the planner behaves normally. The `AFTER DELETE`
trigger is gone and `AFTER UPDATE` only adds.

One detail cost a full debugging cycle: the first version purged with
`WHERE k IN (SELECT id FROM t WHERE id = ?)`, which reintroduced the same scan —
per *call* this time rather than per row — and measured no better. Matching the
shadow's own key directly (`k = ?`, or `k IN (?,?,…)`) is what seeks the index.
The subquery form is right only where it covers many rows at once.

Measured after, on the same 100,000-row browser database: **41,558 ms → 2,209 ms**
in Chromium, 75 ms in WebKit.

Existing databases carry the old triggers, and `CREATE TRIGGER IF NOT EXISTS`
will not replace them — without an explicit retirement step the users with the
most data would have been the only ones left on the slow path. `migrate()` now
drops them on open, including when no version change occurs.

**Guard:** `packages/core/client/test-multientry.mjs`, 23 checks. It asserts the
shadow table exactly equals a rebuild from `_doc` after *every* write path, so a
path added later that forgets its shadow fails without anyone remembering to
write a test. For the cost it asserts the shape rather than a millisecond budget:
writing a fixed number of rows must not get slower as the shadow table grows.
It failed at 10.4x before the fix and passes flat after; the retirement step was
separately verified by disabling it and watching the guard go red.

`db.size()` was found by the same run: documented in the README, present on the
client, and wired to an RPC method no runtime implemented, so it threw every
time it was called. It is now answered by SQLite itself
(`pragma_page_count * pragma_page_size`), which works identically on OPFS,
IndexedDB and memory.

The harness is `examples/playground/scale.js`, run by `scale-test.mjs`. It is
deliberately **not** in `npm test`: 100,000 rows is too slow to pay for on every
commit. Run it before a release, or after touching the query compiler or the
bulk paths.

## Still untested: real Safari

Everything labelled "WebKit" in CI is Playwright's WebKit build. It is close to
Safari and it is the best thing a headless runner can do, but it is not Apple's
shipping browser — different OPFS quotas, different eviction, features that lag
or lead by months. Every Safari claim rests on that substitution.

`examples/playground/safari-test.mjs` drives the real thing over WebDriver (no
new dependency — raw `fetch` against `safaridriver`). It cannot run unattended:
Safari refuses every session until Remote Automation is switched on, and the
switch needs a human at the keyboard.

    Safari > Settings > Advanced > tick "Show features for web developers"
    then the "Developer" tab that appears > tick "Allow remote automation"

(No admin password is needed for that route. `sudo safaridriver --enable` does
the same thing from a terminal and does ask for one, which is why it is not run
from the script. On Safari 16 and earlier the switch lived in the Develop MENU.)

Until someone does that and the runner reports green, "works in Safari" is
inference from a similar engine, not a measurement.

## What the fixes could have broken, and how that is guarded

The parity suite carries explicit regression cases for the ways these changes
could go wrong: that `sortBy` still keeps rows with no key even though `orderBy`
now drops them; that a client-side `.filter()` does not change iteration order;
that `equals`, `between`, `anyOf`, compound `equals`, multiEntry `equals`,
string primary keys, `or()`, Date round-trips and ASCII `equalsIgnoreCase` all
still behave.

The browser suite gained a Unicode case-fold check, because the UDF exists only
on the sqlite-wasm path and its callback there takes a context pointer first —
a signature Node cannot exercise. It caught a real browser-only crash
immediately: sqlite-wasm derives SQL arity from the callback's `length`, so the
first wrapper registered the function as taking zero arguments and **every**
ignore-case query failed in the browser while Node stayed green.

The two guards whose fixes are invisible from the outside — the batch-form
`BEGIN` and the liveQuery dedupe — were each verified by reverting the fix and
watching the guard fail.
