// opfs-leader — one tab owns the worker, every tab can call it.
//
// The topology Notion shipped for WASM-SQLite on OPFS, extracted from the DB.
// No dependency ships this: sqlocal deliberately dropped cross-tab blocking,
// PowerSync/Zero bundle it inside a whole sync platform.
//
// Election is navigator.locks, ~10 lines. No broadcast-channel dependency — that
// library exists for its non-WebLocks fallback (old browsers/Node), which is also
// where its documented duplicate-leadership bug lives. OPFS sync access handles
// need Chrome 108+/Safari 16.4+/Firefox 111+ anyway, and Web Locks is available
// everywhere OPFS is, so the fallback would be dead code that can only be wrong.

/** An Error flattened for structured clone, which does not preserve prototypes. */
export interface SerializedError {
  message: string;
  name: string;
}

export interface LeaderClientOptions {
  /** Namespace. The same name elects one worker across every tab. */
  name: string;
  /** Called ONLY in the tab that wins the election. */
  worker: () => Worker;
  /** How long to wait for a leader to acknowledge a call. Default 5000. */
  timeoutMs?: number;
  /** Called with true/false as this tab gains or loses leadership. */
  onLeadership?: (isLeader: boolean) => void;
  /** Override, for tests. */
  channel?: BroadcastChannel;
  /** Override, for tests. */
  locks?: LockManager;
}

export interface LeaderClient {
  /**
   * Run `method` on the single worker that owns the resource.
   * Rejects with {@link NoLeaderError} (safe to retry) or {@link LeaderLostError}
   * (commit state unknown — do NOT blindly retry).
   */
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
  close(): void;
  readonly isLeader: boolean;
  readonly tabId: string;
}

type ChannelMessage =
  | { kind: 'whois'; from: string }
  | { kind: 'elected'; from: string }
  | { kind: 'call'; callId: string; method: string; args: unknown[]; from: string }
  | { kind: 'ack'; callId: string; to: string }
  | { kind: 'result'; callId: string; to: string; value?: unknown; error?: SerializedError };

/** What the worker posts back for each call. */
export interface WorkerReply {
  callId: string;
  value?: unknown;
  error?: SerializedError;
}

/** Thrown when the leader died after accepting a call but before answering. */
export class LeaderLostError extends Error {
  override readonly name = 'LeaderLostError';
  readonly method: string;
  constructor(method: string) {
    super(
      `opfs-leader: leader died while running "${method}". ` +
        `The operation may or may not have committed — verify or make it idempotent.`
    );
    this.method = method;
  }
}

/** Thrown when no leader answered in time. Safe to retry: nobody accepted it. */
export class NoLeaderError extends Error {
  override readonly name = 'NoLeaderError';
  readonly method: string;
  constructor(method: string) {
    super(`opfs-leader: no leader accepted "${method}" in time.`);
    this.method = method;
  }
}

const noop = (): void => {};

/** Errors lose their prototype through structured clone; the worker sends parts. */
function toError(e: unknown): Error {
  if (e instanceof Error) return e;
  const parts = e as Partial<SerializedError> | undefined;
  const err = new Error(parts?.message ?? String(e));
  err.name = parts?.name ?? 'Error';
  return err;
}

/**
 * Hold leadership for `name` until the returned function is called or the tab dies.
 * Browser-released on tab death — that release IS the failover, no heartbeat needed.
 */
export function holdLeadership(
  name: string,
  onElected: () => void,
  { locks = globalThis.navigator?.locks }: { locks?: LockManager } = {}
): () => void {
  if (!locks?.request) {
    throw new Error(
      'opfs-leader: navigator.locks is unavailable. It requires a secure context ' +
        '(HTTPS or localhost) and Chrome 69+/Safari 15.4+/Firefox 96+.'
    );
  }
  let release: () => void = noop;
  const held = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  void locks.request(`opfs-leader:${name}`, async () => {
    onElected();
    await held; // never resolves until release() — leadership IS the lock
  });
  return () => release();
}

interface PendingCall {
  resolve: (value: never) => void;
  reject: (reason: Error) => void;
  method: string;
  acked: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export function createLeaderClient({
  name,
  worker,
  timeoutMs = 5000,
  onLeadership = noop,
  channel = new BroadcastChannel(`opfs-leader:${name}`),
  locks = globalThis.navigator?.locks,
}: LeaderClientOptions): LeaderClient {
  const tabId =
    globalThis.crypto?.randomUUID?.() ?? `t${Date.now()}${Math.random().toString(36).slice(2)}`;

  let isLeader = false;
  let dbWorker: Worker | null = null;
  let closed = false;
  let seq = 0;

  // Election resolves asynchronously, so the first call in the only open tab can
  // be broadcast before anyone is leader — and a BroadcastChannel never delivers
  // to its own sender, so that call would hang until it timed out. We cannot fix
  // this by retrying: a leader that ACKs late would run the call twice. Instead,
  // hold calls until a leader is known to exist (or we become one).
  let leaderKnown = false;
  const waiters = new Set<() => void>();
  const leaderSettled = (): void => {
    for (const w of waiters) w();
    waiters.clear();
  };
  const awaitLeader = (): Promise<boolean> =>
    isLeader || leaderKnown
      ? Promise.resolve(true)
      : new Promise((resolve) => {
          const done = (): void => {
            waiters.delete(done);
            resolve(true);
          };
          waiters.add(done);
          setTimeout(() => {
            waiters.delete(done);
            resolve(isLeader || leaderKnown);
          }, timeoutMs);
        });

  /** Calls this tab is waiting on, as caller. */
  const pending = new Map<string, PendingCall>();
  /** Calls this tab is running, as leader, so we can answer them. */
  const running = new Map<string, (reply: WorkerReply) => void>();

  function onWorkerMessage(event: MessageEvent): void {
    const msg = event.data as WorkerReply;
    const reply = running.get(msg.callId);
    if (!reply) return;
    running.delete(msg.callId);
    reply(msg);
  }

  const releaseLeadership = holdLeadership(
    name,
    () => {
      // We can win the lock long after close(): the request stays queued until
      // whoever held it releases. Electing a closed client would open a worker
      // nobody can reach and post on a closed channel.
      if (closed) return;
      isLeader = true;
      dbWorker = worker();
      dbWorker.addEventListener('message', (e: MessageEvent) => onWorkerMessage(e));
      // Without this, a worker that fails to load leaves every call awaiting a
      // reply that can never come — the leader path has no timeout by design.
      dbWorker.addEventListener('error', (e: ErrorEvent) => {
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
      channel.postMessage({ kind: 'elected', from: tabId } satisfies ChannelMessage);
      leaderSettled();
      onLeadership(true);
    },
    { locks }
  );

  function runOnWorker(callId: string, method: string, args: unknown[]): Promise<WorkerReply> {
    return new Promise((resolve) => {
      running.set(callId, resolve);
      dbWorker?.postMessage({ callId, method, args });
    });
  }

  function settle(callId: string, msg: { value?: unknown; error?: unknown }): void {
    const call = pending.get(callId);
    if (!call) return;
    pending.delete(callId);
    clearTimeout(call.timer);
    if (msg.error) call.reject(toError(msg.error));
    else call.resolve(msg.value as never);
  }

  channel.addEventListener('message', async (event: MessageEvent) => {
    const msg = event.data as ChannelMessage;
    if (closed) return;

    // A tab that just started asks whether a leader already exists.
    if (msg.kind === 'whois' && isLeader) {
      channel.postMessage({ kind: 'elected', from: tabId } satisfies ChannelMessage);
      return;
    }

    if (msg.kind === 'call' && isLeader) {
      // ACK first: tells the caller "I own this now, do not retry it elsewhere".
      channel.postMessage({ kind: 'ack', callId: msg.callId, to: msg.from } satisfies ChannelMessage);
      const result = await runOnWorker(msg.callId, msg.method, msg.args);
      channel.postMessage({
        kind: 'result',
        callId: msg.callId,
        to: msg.from,
        value: result.value,
        error: result.error,
      } satisfies ChannelMessage);
      return;
    }

    if (msg.kind !== 'ack' && msg.kind !== 'result') return;
    if (msg.to !== tabId) return;
    const call = pending.get(msg.callId);
    if (!call) return;

    if (msg.kind === 'ack') {
      call.acked = true;
      clearTimeout(call.timer);
      return;
    }
    settle(msg.callId, msg);
  });

  // A new leader was elected. Anything we had ACKed was owned by the tab that
  // just died: its fate is unknown, so fail loudly instead of silently retrying.
  channel.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data as ChannelMessage;
    if (msg.kind !== 'elected' || msg.from === tabId) return;
    leaderKnown = true;
    leaderSettled();
    for (const [callId, call] of pending) {
      if (call.acked) settle(callId, { error: new LeaderLostError(call.method) });
    }
  });

  /**
   * The leader is gone until someone claims otherwise.
   *
   * `leaderKnown` used to be set once and never cleared, which made the
   * "hold calls until a leader exists" guard a ONE-SHOT: after a failover,
   * followers still believed a leader was listening and broadcast into the gap
   * where no tab had won the lock yet. BroadcastChannel does not queue, so those
   * messages were simply dropped and the caller waited out the full timeout.
   */
  function forgetLeader(): void {
    if (!isLeader) leaderKnown = false;
  }

  channel.postMessage({ kind: 'whois', from: tabId } satisfies ChannelMessage);

  async function call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    if (closed) throw new Error('opfs-leader: client is closed');

    if (!isLeader && !leaderKnown) await awaitLeader();
    if (closed) throw new Error('opfs-leader: client is closed');

    if (isLeader) {
      const callId = `${tabId}:${seq++}`;
      const result = await runOnWorker(callId, method, args);
      if (result.error) throw toError(result.error);
      return result.value as T;
    }

    const callId = `${tabId}:${seq++}`;
    return new Promise<T>((resolve, reject) => {
      const entry: PendingCall = {
        resolve: resolve as (value: never) => void,
        reject,
        method,
        acked: false,
      };
      entry.timer = setTimeout(() => {
        // Never ACKed => no leader took ownership => nothing ran. Safe to retry.
        // Also forget the leader: nobody answered, so the one we believed in is
        // gone and the next call must wait for a real election instead of
        // broadcasting into a gap where no tab is listening.
        if (!entry.acked) { forgetLeader(); settle(callId, { error: new NoLeaderError(method) }); }
      }, timeoutMs);
      pending.set(callId, entry);
      channel.postMessage({
        kind: 'call',
        callId,
        method,
        args,
        from: tabId,
      } satisfies ChannelMessage);
    });
  }

  function close(): void {
    closed = true;
    for (const [callId, entry] of pending) {
      settle(callId, { error: new Error(`opfs-leader: closed during "${entry.method}"`) });
    }
    // `running` holds calls in flight ON OUR OWN WORKER (the leader's own calls
    // never create a pending entry and arm no timer). terminate() below makes
    // their replies impossible, so without this they hang forever — and because
    // _dispatch awaits them inside withLock('shared'), a hung call holds that
    // lock and deadlocks every tab's transactions.
    for (const [callId, reply] of [...running]) {
      running.delete(callId);
      reply({ callId, error: { message: 'opfs-leader: closed while the call was running', name: 'ClosedError' } });
    }
    releaseLeadership();
    dbWorker?.terminate();
    channel.close();
    if (isLeader) onLeadership(false);
    isLeader = false;
  }

  return {
    call,
    close,
    get isLeader() {
      return isLeader;
    },
    tabId,
  };
}

// NOT re-exported from the barrel on purpose: the cache-race helpers are an
// independent utility, and re-exporting them here drags ~3 kB into every bundle
// that only wanted the leader client. Import 'opfs-leader/race' for them.
