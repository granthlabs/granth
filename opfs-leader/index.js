// opfs-leader — one tab owns the worker, every tab can call it.
//
// The topology Notion shipped for WASM-SQLite on OPFS, extracted from the DB.
// No dependency ships this: sqlocal deliberately dropped cross-tab blocking,
// PowerSync/Zero bundle it inside a whole sync platform. See
// wiki/concepts/opfs-db-leader-lock.md.
//
// ponytail: election is navigator.locks, ~10 lines. No broadcast-channel dep —
// that library exists for its non-WebLocks fallback (old browsers/Node), which
// is also where its documented duplicate-leadership bug lives. OPFS sync access
// handles need Chrome 108+/Safari 16.4+/Firefox 111+ anyway, and Web Locks is
// available everywhere OPFS is, so the fallback path would be dead code that
// can only be wrong.

/** Thrown when the leader died after accepting a call but before answering. */
export class LeaderLostError extends Error {
  constructor(method) {
    super(
      `opfs-leader: leader died while running "${method}". ` +
        `The operation may or may not have committed — verify or make it idempotent.`
    );
    this.name = 'LeaderLostError';
    this.method = method;
  }
}

/** Thrown when no leader answered in time. Safe to retry: nobody accepted it. */
export class NoLeaderError extends Error {
  constructor(method) {
    super(`opfs-leader: no leader accepted "${method}" in time.`);
    this.name = 'NoLeaderError';
    this.method = method;
  }
}

const noop = () => {};

/** Errors lose their prototype through structured clone; the worker sends parts. */
function toError(e) {
  if (e instanceof Error) return e;
  const err = new Error(e?.message ?? String(e));
  err.name = e?.name ?? 'Error';
  return err;
}

/**
 * Hold leadership for `name` until the returned function is called or the tab dies.
 * Browser-released on tab death — that release IS the failover, no heartbeat needed.
 */
export function holdLeadership(name, onElected, { locks = globalThis.navigator?.locks } = {}) {
  if (!locks?.request) {
    throw new Error(
      'opfs-leader: navigator.locks is unavailable. It requires a secure context ' +
        '(HTTPS or localhost) and Chrome 69+/Safari 15.4+/Firefox 96+.'
    );
  }
  let release = noop;
  const held = new Promise((r) => {
    release = r;
  });
  locks.request(`opfs-leader:${name}`, async () => {
    onElected();
    await held; // never resolves until release() — leadership is the lock
  });
  return () => release();
}

/**
 * @param {object}   opts
 * @param {string}   opts.name       Namespace. Same name = same elected worker.
 * @param {Function} opts.worker     Factory returning a dedicated Worker. Called
 *                                   ONLY in the tab that wins the election.
 * @param {number}   [opts.timeoutMs]  How long to wait for a leader to ACK. Default 5000.
 * @param {Function} [opts.onLeadership] Called with (true|false) on election change.
 */
export function createLeaderClient({
  name,
  worker,
  timeoutMs = 5000,
  onLeadership = noop,
  channel = new BroadcastChannel(`opfs-leader:${name}`),
  locks = globalThis.navigator?.locks,
} = {}) {
  const tabId =
    globalThis.crypto?.randomUUID?.() ?? `t${Date.now()}${Math.random().toString(36).slice(2)}`;

  let isLeader = false;
  let dbWorker = null;
  let closed = false;
  let seq = 0;

  // Election resolves asynchronously, so the first call in the only open tab can
  // be broadcast before anyone is leader — and a BroadcastChannel never delivers
  // to its own sender, so that call would hang until it timed out. We cannot fix
  // this by retrying: a leader that ACKs late would run the call twice. Instead,
  // hold calls until a leader is known to exist (or we become one).
  let leaderKnown = false;
  const waiters = new Set();
  function leaderSettled() {
    for (const w of waiters) w();
    waiters.clear();
  }
  function awaitLeader() {
    if (isLeader || leaderKnown) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = () => { waiters.delete(done); resolve(true); };
      waiters.add(done);
      setTimeout(() => { waiters.delete(done); resolve(isLeader || leaderKnown); }, timeoutMs);
    });
  }

  // Calls this tab is waiting on (as caller).
  const pending = new Map(); // callId -> { resolve, reject, method, acked, timer }
  // Calls this tab is running (as leader), so we can answer them.
  const running = new Map(); // callId -> replyFn

  const releaseLeadership = holdLeadership(
    name,
    () => {
      // We can win the lock long after close(): the request stays queued until
      // whoever held it releases. Electing a closed client would open a worker
      // nobody can reach and post on a closed channel.
      if (closed) return;
      isLeader = true;
      dbWorker = worker();
      dbWorker.addEventListener('message', onWorkerMessage);
      // Without this, a worker that fails to load leaves every call awaiting a
      // reply that can never come — the leader path has no timeout by design.
      dbWorker.addEventListener('error', (e) => {
        // A module-load failure fires `error` with an empty message, so include
        // the location and the two causes that actually happen in the field.
        const where = e?.filename ? ` (${e.filename}:${e.lineno ?? 0})` : '';
        const message =
          `opfs-leader: worker failed — ${e?.message || 'the worker script did not load'}${where}. ` +
          `Check the worker URL resolves, and that no other worker still holds the ` +
          `OPFS file (a stale sync access handle throws NoModificationAllowedError).`;
        for (const [callId, reply] of [...running]) {
          running.delete(callId);
          reply({ callId, error: { message, name: 'WorkerError' } });
        }
      });
      // A follower's in-flight call died with the previous leader. It holds an
      // ACK, so it will not retry — surface it rather than hanging forever.
      channel.postMessage({ kind: 'elected', from: tabId });
      leaderSettled();
      onLeadership(true);
    },
    { locks }
  );

  function onWorkerMessage(event) {
    const msg = event.data;
    const reply = running.get(msg.callId);
    if (!reply) return;
    running.delete(msg.callId);
    reply(msg);
  }

  function runOnWorker(callId, method, args) {
    return new Promise((resolve) => {
      running.set(callId, resolve);
      dbWorker.postMessage({ callId, method, args });
    });
  }

  channel.addEventListener('message', async (event) => {
    const msg = event.data;
    if (closed) return;

    // A tab that just started asks whether a leader already exists.
    if (msg.kind === 'whois' && isLeader) {
      channel.postMessage({ kind: 'elected', from: tabId });
      return;
    }
    if (msg.kind === 'call' && isLeader) {
      // ACK first: tells the caller "I own this now, do not retry it elsewhere".
      channel.postMessage({ kind: 'ack', callId: msg.callId, to: msg.from });
      const result = await runOnWorker(msg.callId, msg.method, msg.args);
      channel.postMessage({ kind: 'result', callId: msg.callId, to: msg.from, ...result });
      return;
    }

    if (msg.to && msg.to !== tabId) return;
    const call = pending.get(msg.callId);
    if (!call) return;

    if (msg.kind === 'ack') {
      call.acked = true;
      clearTimeout(call.timer);
      return;
    }
    if (msg.kind === 'result') {
      settle(msg.callId, msg);
    }
  });

  // A new leader was elected. Anything we had ACKed was owned by the tab that
  // just died: its fate is unknown, so fail loudly instead of silently retrying.
  channel.addEventListener('message', (event) => {
    if (event.data.kind !== 'elected' || event.data.from === tabId) return;
    leaderKnown = true;
    leaderSettled();
    for (const [callId, call] of pending) {
      if (call.acked) settle(callId, { error: new LeaderLostError(call.method) });
    }
  });

  channel.postMessage({ kind: 'whois', from: tabId });

  function settle(callId, msg) {
    const call = pending.get(callId);
    if (!call) return;
    pending.delete(callId);
    clearTimeout(call.timer);
    if (msg.error) call.reject(toError(msg.error));
    else call.resolve(msg.value);
  }

  /**
   * Run `method` on the single worker that owns the resource, wherever it lives.
   * Rejects with NoLeaderError (safe to retry) or LeaderLostError (do NOT blindly retry).
   */
  async function call(method, ...args) {
    if (closed) throw new Error('opfs-leader: client is closed');

    if (!isLeader && !leaderKnown) await awaitLeader();
    if (closed) throw new Error('opfs-leader: client is closed');

    if (isLeader) {
      const callId = `${tabId}:${seq++}`;
      const result = await runOnWorker(callId, method, args);
      if (result.error) throw toError(result.error);
      return result.value;
    }

    const callId = `${tabId}:${seq++}`;
    return new Promise((resolve, reject) => {
      const call = { resolve, reject, method, acked: false };
      call.timer = setTimeout(() => {
        // Never ACKed => no leader took ownership => nothing ran. Safe to retry.
        if (!call.acked) settle(callId, { error: new NoLeaderError(method) });
      }, timeoutMs);
      pending.set(callId, call);
      channel.postMessage({ kind: 'call', callId, method, args, from: tabId });
    });
  }

  function close() {
    closed = true;
    for (const [callId, call] of pending) {
      settle(callId, { error: new Error(`opfs-leader: closed during "${call.method}"`) });
    }
    releaseLeadership();
    dbWorker?.terminate?.();
    channel.close?.();
    if (isLeader) onLeadership(false);
    isLeader = false;
  }

  return { call, close, get isLeader() { return isLeader; }, tabId };
}

export { staleWhileRevalidate, raceFirstWin, hedge } from './race.js';
