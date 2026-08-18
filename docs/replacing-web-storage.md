# Replacing localStorage, sessionStorage and IndexedDB

Most apps reach for `localStorage` because it is two lines, then keep using it
long after it stopped fitting. This page is about when that has happened, and
what to move to.

## The honest comparison

| | localStorage | sessionStorage | IndexedDB | granthdb |
|---|---|---|---|---|
| API | sync, blocking | sync, blocking | async, callback-ish | async, promise |
| Stores | **strings only** | strings only | structured clone | structured clone |
| Typical limit | ~5 MB | ~5 MB | large (quota-based) | large (quota-based) |
| Blocks the main thread | **yes** | yes | no | no — runs in a Worker |
| Queries | none — you scan | none | one index per query | SQL planner, any index |
| Sort by a different field | JS sort | JS sort | JS sort | one statement |
| Transactions | no | no | yes | yes, cross-tab |
| Survives a tab close | yes | **no** | yes | yes |
| Multi-tab writes | last writer wins | n/a | last writer wins | one elected writer |

### The one that actually bites: localStorage is synchronous

Every `localStorage.getItem` blocks the main thread. It is invisible at 5 KB and
a visible jank at 5 MB, and because it is synchronous you cannot move it off the
critical path. `JSON.parse(localStorage.getItem('cache'))` on a large blob is a
frame drop, every navigation.

granthdb runs SQL in a dedicated Worker. A slow query does not stutter your
animation, because it is not on your thread at all.

## When to move — and when not to

**Stay on localStorage** for a theme preference, a dismissed banner, a feature
flag. A few keys of a few bytes. Adding a WASM SQLite build to store
`{"theme":"dark"}` is worse engineering, not better.

**Move** when any of these is true:

- you are storing more than a megabyte or two
- you are storing a **list** and filtering or sorting it in JavaScript
- you `JSON.parse` the same blob on every page load
- you have hit `QuotaExceededError`
- two tabs of your app can disagree about the data
- reads show up in a performance profile

**sessionStorage** is a different case: its whole point is that it dies with the
tab. If you rely on that, keep it. If you were only using it to avoid
localStorage's persistence, use granthdb and delete the rows yourself — you get
querying and no size ceiling.

**IndexedDB** is the closest comparison, and the honest summary is that granthdb
is IndexedDB's model with a real query engine underneath. See
[Migrating from Dexie](/migrating-from-dexie) — the same import path brings raw
IndexedDB data across, schema inference included.

## Moving a localStorage blob across

The usual shape — one key holding an array, parsed on boot:

```js
// before
const todos = JSON.parse(localStorage.getItem('todos') ?? '[]');
const open = todos.filter((t) => !t.done).sort((a, b) => a.created - b.created);
```

```js
// after
db.version(1).stores({ todos: '++id, done, created' });

// one-time migration, then never parse a blob again
const legacy = JSON.parse(localStorage.getItem('todos') ?? '[]');
if (legacy.length) {
  await db.todos.bulkAdd(legacy);
  localStorage.removeItem('todos');
}

// filter on one index, order by another — in SQLite, not in JS
const open = await db.todos.where('done').equals(false).orderBy('created').toArray();
```

The second version does not grow slower as the list grows, because it stops
loading the whole list.

## Where auth tokens belong (read this first)

**Do not move session tokens into granthdb. It is not safer than localStorage
for that, and nothing in the browser that JavaScript can read is.**

The threat you care about with a token is XSS. Any script running on your origin
can call `db.tokens.get()` exactly as easily as it can call
`localStorage.getItem('token')`. Encrypting it does not help either: the script
just calls your decrypt path. Moving a token from localStorage to *any*
JS-readable store is motion, not progress.

**The actual answer is an `httpOnly` cookie**, which JavaScript cannot read at
all:

```
Set-Cookie: session=…; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=1209600
```

`HttpOnly` puts it out of reach of script. `Secure` keeps it off plaintext HTTP.
`SameSite` blunts CSRF. That is a real boundary enforced by the browser, not a
convention your code has to maintain.

If you hold a token in memory because you are using a bearer-token flow, keep it
in a module-scoped variable — gone on reload, never serialised, never in any
store. Pair it with a refresh token in an `httpOnly` cookie.

### What granthdb IS the right place for

User *data*, which is a different problem:

- documents, messages, notes, drafts, cached records
- anything you would otherwise `JSON.parse` out of a 5 MB localStorage string
- anything you want to query rather than scan

And for that data, [field-level encryption](/encryption) genuinely helps —
against device theft, disk forensics and backup extraction. It does not help
against XSS, and the page says so.

## Feature detection and fallback

```js
import { Granth } from 'granthdb';

if (!Granth.isSupported()) {
  // SSR, no Web Locks, or an insecure context. Keep a path that works.
  return legacyLocalStorageMode();
}
```

The storage list already degrades on its own — OPFS, then IndexedDB, then
memory — so Safari private browsing gets a working database rather than an
exception. See [Storage](/storage).
