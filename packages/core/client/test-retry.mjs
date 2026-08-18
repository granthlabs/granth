// Auto-retry of NoLeaderError, and the far more important half: that
// LeaderLostError is NEVER retried.
//
// `NoLeaderError` means nothing ran — a guarantee that only became true once the
// leader started fencing calls whose caller had already given up (see
// opfs-leader/test-slow-leader.mjs). Before that fence, retrying automatically
// would have turned an occasional hiccup into a systematic double-write, which
// is why the concurrency suite recorded "the library could retry it itself" as a
// note rather than doing it.
//
// `LeaderLostError` is the opposite: the leader ACKed and then died, so the
// commit state is unknowable. Retrying that silently is exactly the data
// corruption the two errors exist to keep apart.

import { Granth, NoLeaderError, LeaderLostError } from 'granthdb';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

/**
 * A runtime whose connection fails the first `n` calls matching `when`, then
 * behaves. Counts what actually reached the engine so a "retry" that silently
 * ran twice is visible.
 */
function flakyRuntime({ failWith, times, when = () => true }) {
  const seen = [];
  let left = times;
  return {
    plugin: {
      name: 'flaky',
      isAvailable: () => true,
      connect() {
        return {
          async call(method, ...args) {
            if (left > 0 && when(method)) {
              left--;
              seen.push({ method, rejected: failWith.name });
              throw failWith;
            }
            seen.push({ method, ran: true });
            if (method === 'open') return { version: 1, from: 0, migrated: true, schema: {} };
            if (method === 'add' || method === 'put') return 1;
            return undefined;
          },
          async withLock(_mode, fn) { return fn(); },
          onRemoteChange() { return () => {}; },
          onLeadershipChange() { return () => {}; },
          broadcastChange() {},
          close() {},
        };
      },
    },
    seen,
    ran: () => seen.filter((s) => s.ran),
  };
}

const schema = { friends: '++id, name' };

// 1 — open() is idempotent and was the call the concurrency suite kept having to
//     retry by hand. It must now recover on its own.
{
  const r = flakyRuntime({ failWith: new NoLeaderError('open'), times: 1 });
  const db = new Granth('retry-open', { runtime: r.plugin });
  db.version(1).stores(schema);
  let err = null;
  await db.open().catch((e) => { err = e; });
  check('open() recovers from a single NoLeaderError', !err, err?.name ?? '');
  check('and it reached the engine exactly once',
    r.ran().filter((s) => s.method === 'open').length === 1,
    `${r.ran().filter((s) => s.method === 'open').length} execution(s)`);
}

// 2 — an ordinary write. Nothing ran, so exactly one must run after the retry.
{
  const r = flakyRuntime({ failWith: new NoLeaderError('add'), times: 1, when: (m) => m === 'add' });
  const db = new Granth('retry-add', { runtime: r.plugin });
  db.version(1).stores(schema);
  let err = null;
  await db.friends.add({ name: 'ada' }).catch((e) => { err = e; });
  check('a write recovers from NoLeaderError', !err, err ? `${err.name}: ${err.message}` : '');
  check('and the write reached the engine exactly once',
    r.ran().filter((s) => s.method === 'add').length === 1,
    `${r.ran().filter((s) => s.method === 'add').length} execution(s)`);
}

// 3 — THE ONE THAT MATTERS. LeaderLostError means the call may have committed.
//     Retrying it is the double-write this whole contract exists to prevent.
{
  const r = flakyRuntime({ failWith: new LeaderLostError('add'), times: 1, when: (m) => m === 'add' });
  const db = new Granth('retry-lost', { runtime: r.plugin });
  db.version(1).stores(schema);
  let err = null;
  await db.friends.add({ name: 'ada' }).catch((e) => { err = e; });
  check('LeaderLostError is surfaced, never retried', err instanceof LeaderLostError,
    err?.name ?? 'no error — it was swallowed');
  check('and nothing ran a second time',
    r.ran().filter((s) => s.method === 'add').length === 0,
    `${r.ran().filter((s) => s.method === 'add').length} execution(s)`);
}

// 3b — open() is the ONE call allowed to retry a LeaderLostError, because
//      re-running it is indistinguishable from running it once. An app starting
//      while another tab closes should not get a hard startup error.
{
  const r = flakyRuntime({ failWith: new LeaderLostError('open'), times: 1, when: (m) => m === 'open' });
  const db = new Granth('retry-open-lost', { runtime: r.plugin });
  db.version(1).stores(schema);
  let err = null;
  await db.open().catch((e) => { err = e; });
  check('open() recovers from LeaderLostError (it is idempotent)', !err,
    err ? `${err.name}: ${err.message}` : '');
  check('and open reached the engine exactly once after recovering',
    r.ran().filter((s) => s.method === 'open').length === 1,
    `${r.ran().filter((s) => s.method === 'open').length} execution(s)`);
}

// 3c — A FRESHLY ELECTED leader has no schema until it runs migrate(). Schema
//      lives in the leader's engine, not in the file, so a follower holding a
//      resolved open() can send a data call to the new leader before it has
//      re-opened and get "Declared: (none)". That is recoverable — re-open and
//      retry — not a bad query. Timing-dependent in the wild (it only showed up
//      on a slow CI runner), so it is forced deterministically here.
{
  let served = 0;
  const plugin = {
    name: 'schemaless-once',
    isAvailable: () => true,
    connect() {
      let opened = 0;
      return {
        async call(method) {
          if (method === 'open') { opened++; return { version: 1, from: 0, migrated: true, schema: {} }; }
          // The first data call lands on a leader that has not migrated yet.
          if (++served === 1) throw new Error('granth: no table "friends". Declared: (none)');
          return 1;
        },
        get opened() { return opened; },
        async withLock(_m, fn) { return fn(); },
        onRemoteChange() { return () => {}; },
        onLeadershipChange() { return () => {}; },
        broadcastChange() {},
        close() {},
      };
    },
  };
  const db = new Granth('schemaless', { runtime: plugin });
  db.version(1).stores(schema);
  let err = null;
  await db.friends.add({ name: 'ada' }).catch((e) => { err = e; });
  check('a data call against a schema-less leader re-opens and succeeds', !err,
    err ? `${err.name}: ${err.message}` : '');
  check('and it did not silently swallow a genuine schema error',
    served === 2, `${served} data call(s)`);
}

// 3d — but a table that genuinely is not declared must still fail loudly.
{
  const plugin = {
    name: 'always-schemaless',
    isAvailable: () => true,
    connect: () => ({
      async call(method) {
        if (method === 'open') return { version: 1, from: 0, migrated: true, schema: {} };
        throw new Error('granth: no table "friends". Declared: (none)');
      },
      async withLock(_m, fn) { return fn(); },
      onRemoteChange() { return () => {}; },
      onLeadershipChange() { return () => {}; },
      broadcastChange() {},
      close() {},
    }),
  };
  const db = new Granth('always-schemaless', { runtime: plugin });
  db.version(1).stores(schema);
  let err = null;
  await db.friends.add({ name: 'ada' }).catch((e) => { err = e; });
  check('a persistently undeclared table still fails loudly', /Declared: \(none\)/.test(String(err?.message)),
    err ? err.message.slice(0, 60) : 'no error — it looped or swallowed');
}

// 4 — retries are BOUNDED. A tab closing for good must surface, not spin.
{
  const r = flakyRuntime({ failWith: new NoLeaderError('add'), times: 99, when: (m) => m === 'add' });
  const db = new Granth('retry-bounded', { runtime: r.plugin });
  db.version(1).stores(schema);
  let err = null;
  await db.friends.add({ name: 'ada' }).catch((e) => { err = e; });
  check('a persistent NoLeaderError still surfaces', err instanceof NoLeaderError,
    err?.name ?? 'no error');
  const attempts = r.seen.filter((s) => s.method === 'add').length;
  check('and the attempts are bounded', attempts > 1 && attempts <= 4, `${attempts} attempt(s)`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nretry: NoLeaderError recovers, LeaderLostError never does');
process.exit(failures ? 1 : 0);
