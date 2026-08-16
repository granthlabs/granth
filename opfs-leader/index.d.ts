/** Thrown when the leader died after accepting a call but before answering. */
export declare class LeaderLostError extends Error {
  readonly name: 'LeaderLostError';
  readonly method: string;
  constructor(method: string);
}

/** Thrown when no leader answered in time. Safe to retry: nobody accepted it. */
export declare class NoLeaderError extends Error {
  readonly name: 'NoLeaderError';
  readonly method: string;
  constructor(method: string);
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
  /** Override for testing. */
  channel?: BroadcastChannel;
  /** Override for testing. */
  locks?: LockManager;
}

export interface LeaderClient {
  /**
   * Run `method` on the single worker that owns the resource.
   * Rejects with {@link NoLeaderError} (safe to retry) or
   * {@link LeaderLostError} (commit state unknown — do NOT blindly retry).
   */
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
  close(): void;
  readonly isLeader: boolean;
  readonly tabId: string;
}

export declare function createLeaderClient(opts: LeaderClientOptions): LeaderClient;

/**
 * Hold leadership for `name` until the returned function is called or the tab dies.
 * The browser releases the lock on tab death — that release is the failover.
 */
export declare function holdLeadership(
  name: string,
  onElected: () => void,
  opts?: { locks?: LockManager }
): () => void;

export { staleWhileRevalidate, raceFirstWin, hedge } from './race.js';
