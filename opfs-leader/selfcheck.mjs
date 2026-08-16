// Run: node selfcheck.mjs
// ponytail: one runnable check, no framework. Stubs Web Locks + Worker so the
// topology (election, routing, failover, ACK-vs-retry) is testable in Node.
// Node's own BroadcastChannel is real and cross-instance, so that part isn't faked.

import assert from 'node:assert/strict';
import { createLeaderClient, LeaderLostError, NoLeaderError } from './index.js';
import { staleWhileRevalidate, raceFirstWin, hedge } from './race.js';

// --- stubs -----------------------------------------------------------------

/** Minimal Web Locks: exclusive, FIFO queue, released when the callback settles. */
function makeLocks() {
  const queues = new Map();
  return {
    async request(name, fn) {
      const tail = queues.get(name) ?? Promise.resolve();
      let done;
      const mine = new Promise((r) => (done = r));
      queues.set(name, tail.then(() => mine));
      await tail;
      try {
        return await fn();
      } finally {
        done();
      }
    },
  };
}

/** A fake dedicated worker holding "the database". */
function makeWorker(store) {
  const listeners = [];
  let terminated = false;
  return {
    terminated: () => terminated,
    addEventListener: (_t, fn) => listeners.push(fn),
    terminate: () => (terminated = true),
    postMessage({ callId, method, args }) {
      queueMicrotask(() => {
        if (terminated) return; // dead worker never answers — exactly the failover case
        let msg;
        try {
          if (method === 'set') { store.set(args[0], args[1]); msg = { callId, value: 'ok' }; }
          else if (method === 'get') msg = { callId, value: store.get(args[0]) };
          else if (method === 'boom') throw new Error('worker exploded');
          else throw new Error(`no handler "${method}"`);
        } catch (err) {
          msg = { callId, error: { message: err.message, name: err.name } };
        }
        listeners.forEach((fn) => fn({ data: msg }));
      });
    },
  };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// --- the topology ----------------------------------------------------------

const locks = makeLocks();
const store = new Map();
const workers = [];
const spawn = () => { const w = makeWorker(store); workers.push(w); return w; };

// 0. The FIRST call in the ONLY tab, issued before the lock has been granted.
//    A BroadcastChannel never delivers to its own sender, so a call dispatched
//    during that window is lost. Regression guard: this must not hang or reject.
{
  const soloStore = new Map();
  const solo = createLeaderClient({
    name: 'solo', worker: () => makeWorker(soloStore), locks: makeLocks(), timeoutMs: 300,
  });
  assert.equal(await solo.call('set', 'k', 'early'), 'ok', 'a call issued before election must still land');
  assert.equal(await solo.call('get', 'k'), 'early');
  solo.close();
}

const tabA = createLeaderClient({ name: 'test', worker: spawn, locks, timeoutMs: 200 });
const tabB = createLeaderClient({ name: 'test', worker: spawn, locks, timeoutMs: 200 });
const tabC = createLeaderClient({ name: 'test', worker: spawn, locks, timeoutMs: 200 });
await tick();

// 1. Exactly one leader, and only the leader ever built a worker.
const leaders = [tabA, tabB, tabC].filter((t) => t.isLeader);
assert.equal(leaders.length, 1, 'exactly one tab must win the election');
assert.equal(workers.length, 1, 'a follower must NOT open the resource — that is the corruption bug');

// 2. A follower's write reaches the single writer, and a different follower reads it back.
const followers = [tabA, tabB, tabC].filter((t) => !t.isLeader);
assert.equal(await followers[0].call('set', 'k', 'v1'), 'ok');
assert.equal(await followers[1].call('get', 'k'), 'v1', 'follower reads must route to the leader');
assert.equal(await leaders[0].call('get', 'k'), 'v1', 'leader must serve itself too');

// 3. Worker errors propagate as real Errors across the tab boundary.
await assert.rejects(() => followers[0].call('boom'), /worker exploded/);
await assert.rejects(() => followers[0].call('nope'), /no handler/);

// 4. Failover: kill the leader, a follower is elected and opens a NEW worker.
leaders[0].close();
await tick(50);
const after = followers.filter((t) => t.isLeader);
assert.equal(after.length, 1, 'leadership must transfer when the leader dies');
assert.equal(workers.length, 2, 'the new leader opens its own worker');
assert.equal(await followers.find((t) => !t.isLeader).call('get', 'k'), 'v1', 'routing survives failover');

// 5. No leader at all => NoLeaderError, which is the *retryable* one.
const orphanLocks = makeLocks();
let blockElection;
orphanLocks.request('opfs-leader:orphan', () => new Promise((r) => (blockElection = r)));
const orphan = createLeaderClient({ name: 'orphan', worker: spawn, locks: orphanLocks, timeoutMs: 100 });
await assert.rejects(() => orphan.call('get', 'k'), NoLeaderError, 'un-ACKed call must be safe-to-retry');
orphan.close(); blockElection();

// 6. LeaderLostError is distinct from NoLeaderError — the caller must be able to
//    tell "nothing ran" from "unknown whether it committed".
assert.notEqual(LeaderLostError, NoLeaderError);
assert.match(new LeaderLostError('set').message, /may or may not have committed/);

[tabA, tabB, tabC].forEach((t) => t.close());

// --- race helpers ----------------------------------------------------------

const slow = (v, ms) => () => new Promise((r) => setTimeout(() => r(v), ms));

// SWR: cache wins the critical path even when the network is faster.
assert.equal(await staleWhileRevalidate(slow('cached', 30), slow('fresh', 1)), 'cached');
// SWR: a cache miss falls through to the network.
assert.equal(await staleWhileRevalidate(async () => undefined, slow('fresh', 1)), 'fresh');
// SWR: onFresh still receives the revalidated value.
let fresh; await staleWhileRevalidate(slow('cached', 1), slow('fresh', 5), (v) => (fresh = v));
await tick(20); assert.equal(fresh, 'fresh');

// Race: the slow-disk case Notion hit — network must be allowed to win.
assert.equal(await raceFirstWin(slow('cached', 50), slow('fresh', 1)), 'fresh');
// Race: a cache MISS must not beat the network with `undefined`.
assert.equal(await raceFirstWin(async () => undefined, slow('fresh', 5)), 'fresh');

// Hedge: a fast cache means the network is never consulted.
let netCalls = 0;
assert.equal(await hedge(slow('cached', 1), () => { netCalls++; return slow('fresh', 1)(); }, 50), 'cached');
await tick(80); assert.equal(netCalls, 0, 'hedge must not fire the network when the cache answers in time');

console.log('opfs-leader selfcheck: all assertions passed');
