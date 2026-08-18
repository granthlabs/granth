# Errors

```js
import { VersionError, NoLeaderError, LeaderLostError } from 'granthdb';
```

## `VersionError`

The database file is at a **newer** version than the code declares — usually another tab
running a newer build. Reload.

## `NoLeaderError` — safe to retry

No tab acknowledged the call within `timeoutMs`, so **nothing ran**. Retrying cannot
double-write.

That is guaranteed by more than the missing acknowledgement. A leader can also fail to
acknowledge simply because it is *slow* — a frozen background tab keeps its Web Lock, so
nothing re-elects, and the browser queues messages for it rather than dropping them. So
every call carries a **deadline**, and a leader that reads one after the caller stopped
waiting refuses to run it. Without that fence, a thawing tab would run a call you had
already given up on and retried, and the write would land twice.

The leader's cutoff is deliberately slightly earlier than yours, leaving room for its
acknowledgement to reach you — so a call it accepts is never reported as un-accepted.

## `LeaderLostError` — do NOT blindly retry

The leader acknowledged the call and then died. The commit state is **unknown**.

```js
try {
  await db.friends.add(row);
} catch (e) {
  if (e instanceof NoLeaderError)   retry();
  if (e instanceof LeaderLostError) await verifyThenMaybeRetry();
}
```

The leader acknowledges a call *before* running it. That acknowledgement is exactly what makes
these two cases distinguishable — without it, every timeout would be the dangerous one.

## Schema drift

> the schema declared for version 1 does not match the database — missing table "notes".
> Schema changes need a NEW version.

You changed `stores({...})` without bumping the version. Dexie requires the bump too; here it
fails immediately instead of surfacing later as "no such table".

## Unsupported environment

> granth: this environment cannot run the database.

No Web Locks / Workers, or not a secure context (needs HTTPS or `localhost`). Also what you get
during SSR. Guard with `Granth.isSupported()`.

## Constraint violations

Unique index violations surface as SQLite errors containing `UNIQUE constraint failed`, and
`add()` on an existing key throws (use `put()` to upsert).
