# granthdb 0.2.12

**A worker that cannot start left `open()` pending forever, with nothing logged.
If your app has ever been reported as "the database just never loads", upgrade.**

## The bug

Leadership is taken inside a Web Locks request, and that request promise is
deliberately not awaited — leadership is held for the life of the tab, not
waited on:

```js
void locks.request(`opfs-leader:${name}`, async () => {
  onElected();          // constructs the database worker
  await held;           // never resolves until release()
});
```

`onElected()` constructs the caller's worker. When that throws, the throw had
nowhere to go: the only promise that could carry it was voided. The tab had
already set `isLeader = true`, so it never asked anyone else to lead, and it
never posted `elected`, so nothing settled the calls queued behind the election.

The result in a browser was a database that **hangs forever and says nothing**.
No error, no rejection, no console output — `open()` and every call after it
simply stayed pending. The realistic causes are all mundane:

- a Content-Security-Policy that blocks the worker URL
- a worker script that 404s after a deploy moved it
- a bundler that emitted the worker at a path the page cannot resolve

It was never Node-only. Browsers have always had `navigator.locks`, so browsers
have always had this. What changed is that **Node 24 ships a native
`navigator.locks`**, which turned the same silent throw into an unhandled
rejection — and an unhandled rejection ends the process. That is how a defect
that had been swallowed for its whole life finally became visible: the repo's
own `test-selfcheck.mjs` stopped passing and started crashing.

## The fix

`holdLeadership` catches a failure from `onElected` and hands it to an `onError`
callback, then returns — which releases the lock, so another tab can lead
instead of queueing behind a leader that never was one.

`createLeaderClient` turns that into a real failure with a real message:

```
opfs-leader: this tab was elected leader but cannot run the database —
Refused to create a worker from the URL (CSP). Check that the worker URL
resolves and is not blocked by the page's Content-Security-Policy.
```

Everything already waiting is settled with it, and every later call fails with
it **immediately** rather than waiting out its own `timeoutMs` for an answer
that is never coming.

## Verified

`packages/opfs-leader/test-selfcheck.mjs` now drives a worker factory that
throws and asserts three things: the call fails rather than hanging, the message
says what happened, and a second call fails fast instead of timing out again.

Confirmed to discriminate by reverting the fix: without it the test does not
merely fail, it takes the process down with the original uncaught error — which
is precisely the shape of the defect.

## Compatibility

No API change. `holdLeadership`'s options gained an optional `onError`; every
existing call site keeps working, and one that does not pass it now logs nothing
different from before rather than losing the error.
