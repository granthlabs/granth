// Run: node test-slow-leader.mjs
//
// THE QUESTION: `NoLeaderError` is documented as "safe to retry". Is it?
//
// The ACK-before-run contract says a leader ACKs before doing any work, so a
// call that was never ACKed was never owned by anyone and therefore never ran.
// That reasoning holds when there is genuinely no leader. It does NOT obviously
// hold for a leader that is merely SLOW: a frozen background tab keeps its Web
// Lock, so no re-election happens, and BroadcastChannel messages posted to it
// are QUEUED by the browser rather than dropped. If the caller gives up first
// and retries — as we tell people to — the thawing leader may then run both.
//
// An earlier attempt to reproduce this failed for a harness reason: both clients
// shared one fake LockManager, so the follower elected ITSELF and never took the
// follower path at all. This pins the leader by having it hold the lock forever,
// and stalls only its channel delivery — which is what a frozen tab actually is.

import assert from 'node:assert/strict';
import { createLeaderClient, NoLeaderError } from 'opfs-leader';

/** Exclusive, FIFO, released when the callback settles — same as the main selfcheck. */
function makeLocks() {
  const queues = new Map();
  return {
    async request(name, fn) {
      const tail = queues.get(name) ?? Promise.resolve();
      let done;
      const mine = new Promise((r) => (done = r));
      queues.set(name, tail.then(() => mine));
      await tail;
      try { return await fn(); } finally { done(); }
    },
  };
}

/**
 * A BroadcastChannel whose DELIVERY can be paused — a frozen tab.
 *
 * Posting still works (the browser queues to a frozen tab; it does not drop),
 * and everything the tab was sent while stalled arrives at once when it thaws.
 */
function stallableChannel(name) {
  const real = new BroadcastChannel(name);
  const listeners = [];
  let stalled = false;
  const held = [];
  real.addEventListener('message', (e) => {
    if (stalled) { held.push(e); return; }
    for (const fn of listeners) fn(e);
  });
  return {
    get stalled() { return stalled; },
    stall() { stalled = true; },
    resume() {
      stalled = false;
      const q = held.splice(0);
      for (const e of q) for (const fn of listeners) fn(e);
    },
    addEventListener: (_t, fn) => listeners.push(fn),
    removeEventListener: (_t, fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    postMessage: (m) => real.postMessage(m),
    close: () => real.close(),
  };
}

/** A worker that COUNTS how many times each call actually executed. */
function countingWorker(log) {
  const listeners = [];
  return {
    addEventListener: (_t, fn) => listeners.push(fn),
    terminate() {},
    postMessage({ callId, method, args }) {
      queueMicrotask(() => {
        log.push({ method, args });
        listeners.forEach((fn) => fn({ data: { callId, value: 'ok' } }));
      });
    },
  };
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const NAME = 'slow-leader';
// The library namespaces its own channel, so a wrapper has to use the SAME name
// or the two clients simply never hear each other — which looks exactly like the
// bug under test and would have "reproduced" it for entirely the wrong reason.
const CHANNEL = `opfs-leader:${NAME}`;
const TIMEOUT = 300;

const applied = [];
const locks = makeLocks();

// The leader takes the lock first and never lets go, so no re-election can
// happen while it is stalled — which is the whole point of "slow, not dead".
const leaderChannel = stallableChannel(CHANNEL);
const leader = createLeaderClient({
  name: NAME,
  worker: () => countingWorker(applied),
  locks,
  channel: leaderChannel,
  timeoutMs: TIMEOUT,
});
await tick(50);

const follower = createLeaderClient({
  name: NAME,
  worker: () => countingWorker(applied),
  locks,
  timeoutMs: TIMEOUT,
});
await tick(50);

// Sanity: the follower must actually BE a follower, or the test proves nothing.
// This is exactly what the previous attempt got wrong.
const before = applied.length;
await follower.call('set', 'warmup', 1);
check('the follower routes through the leader (not self-elected)',
  applied.length === before + 1, `${applied.length - before} execution(s)`);

// --- the scenario ----------------------------------------------------------

leaderChannel.stall();

const appliedBefore = applied.length;
let firstError = null;
const first = follower.call('set', 'balance', 'charge-1').catch((e) => { firstError = e; });
await first;

check('a stalled leader makes the caller give up with NoLeaderError',
  firstError instanceof NoLeaderError, String(firstError?.name ?? 'no error'));

// The caller does what the error tells it to do.
let retryError = null;
const retry = follower.call('set', 'balance', 'charge-1').catch((e) => { retryError = e; });
await tick(20);

// The tab thaws. Everything posted to it while frozen is delivered now.
leaderChannel.resume();
await tick(TIMEOUT + 120);
await retry;

const charges = applied.filter((c) => c.args?.[0] === 'balance').length;
check(
  'a retry after NoLeaderError applies the write exactly ONCE',
  charges === 1,
  `applied ${charges}× (retry ${retryError ? `failed: ${retryError.name}` : 'succeeded'}), ` +
    `${applied.length - appliedBefore} total execution(s) since the stall`
);

// --- the fence must not be trigger-happy ------------------------------------

// A leader that is merely a bit late is still a working leader. If the fence
// refused those too, it would turn ordinary jank into spurious failures — worse
// than the bug it fixes, and the kind of overcorrection that is easy to miss
// because the double-apply test would still pass.
{
  const n = applied.length;
  leaderChannel.stall();
  const p = follower.call('set', 'brief', 'ok');
  await tick(Math.floor(TIMEOUT / 3));
  leaderChannel.resume();
  let err = null;
  const value = await p.catch((e) => { err = e; });
  check('a briefly-stalled leader still serves the call', !err && value === 'ok',
    err ? err.name : `returned ${JSON.stringify(value)}`);
  check('and it ran exactly once', applied.filter((c) => c.args?.[0] === 'brief').length === 1,
    `${applied.length - n} execution(s)`);
}

// The leader's own calls never cross the channel, so they must be untouched by
// any of this.
{
  const n = applied.length;
  const value = await leader.call('set', 'leader-local', 1).catch((e) => e);
  check('the leader still serves its own calls', value === 'ok' && applied.length === n + 1,
    String(value?.name ?? value));
}

leader.close();
follower.close();
leaderChannel.close();

console.log(
  failures
    ? `\n${failures} FAILURE(S) — "safe to retry" is not true for a slow leader`
    : '\nslow-leader: an abandoned call never executes, so retrying is genuinely safe'
);
process.exit(failures ? 1 : 0);
