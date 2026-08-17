/**
 * granth-protocol — the contracts every other package implements.
 *
 * Types only, zero runtime, zero dependencies. It exists so that storage,
 * runtimes, bindings and addons can be written against a stable surface without
 * importing each other (or the client), which is what makes them independently
 * publishable and swappable.
 *
 * Three extension points, deliberately no more:
 *
 *   StoragePlugin  — WHERE the bytes live      (OPFS, IndexedDB, memory, …)
 *   RuntimePlugin  — WHERE the SQL executes    (dedicated worker, inline, …)
 *   LitiePlugin    — everything else           (hooks, encryption, sync, …)
 */

// ---------------------------------------------------------------- SQL adapter

/** The minimal synchronous SQL surface the engine needs. */
export interface Adapter {
  all(sql: string, params?: unknown[]): Array<Record<string, unknown>>;
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  /**
   * Register a scalar SQL function. Optional, but WITHOUT it the ignore-case
   * operators fall back to SQLite's built-in lower(), which folds A-Z only —
   * equalsIgnoreCase('ÉCOLE') then misses 'école', and every non-English search
   * box under-matches in silence. Every adapter shipped here provides it.
   */
  createFunction?(name: string, fn: (...args: unknown[]) => unknown): void;
}

// ---------------------------------------------------------------- storage

export interface StorageOpenOptions {
  /** OPFS path or IndexedDB key. */
  filename: string;
  /** Applied at open, e.g. `{ cache_size: -8000 }`. */
  pragmas?: Record<string, string | number>;
  /** Debounce for backends that checkpoint rather than write in place. */
  checkpointMs?: number;
  /** The initialised sqlite3 module. */
  sqlite3: unknown;
}

export interface StorageHandle {
  /** Reported by `db.storageKind()`. */
  readonly kind: string;
  readonly adapter: Adapter;
  /** Called after every write. A no-op for in-place backends like OPFS. */
  markDirty(): void;
  /** Persist now. A no-op for in-place backends. */
  flush(): Promise<void>;
  /** Destroy the underlying data. Not recoverable. */
  destroy(): Promise<void>;
}

export interface StoragePlugin {
  readonly name: string;
  /**
   * Can this backend run *here*? Checked in order, so a list like
   * `[opfs, indexeddb, memory]` degrades instead of throwing — which is the
   * whole reason Safari private browsing (no OPFS at all) does not break apps.
   */
  isAvailable(sqlite3: unknown): Promise<boolean> | boolean;
  open(opts: StorageOpenOptions): Promise<StorageHandle>;
}

// ---------------------------------------------------------------- runtime

/** A connection to wherever the SQL actually runs. */
export interface RuntimeConnection {
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
  close(): void;
  /** Fired when another context (tab) writes. */
  onRemoteChange(fn: (tables: string[]) => void): () => void;
  /** Tell other contexts we wrote. */
  broadcastChange(tables: string[]): void;
  /**
   * Serialise against interactive transactions: ordinary calls take 'shared',
   * transactions take 'exclusive'. A single-context runtime can no-op this.
   */
  withLock<T>(mode: 'shared' | 'exclusive', fn: () => Promise<T>): Promise<T>;
  /**
   * Fired when THIS context becomes the writer (or stops being it).
   *
   * The client needs it because schema lives in the leader's engine, not in the
   * file: a newly elected worker has never run migrate(), so every call fails
   * with `no table "x". Declared: (none)` until open() is re-sent. Optional —
   * single-context runtimes have no leadership to report.
   */
  onLeadershipChange?(fn: (isLeader: boolean) => void): () => void;
}

export interface RuntimeConnectOptions {
  /** Database name, used to namespace locks and channels. */
  name: string;
  timeoutMs?: number;
}

export interface RuntimePlugin {
  readonly name: string;
  isAvailable(): boolean;
  connect(opts: RuntimeConnectOptions): RuntimeConnection;
}

// ---------------------------------------------------------------- addons

/**
 * Operations an addon can intercept.
 *
 * These are the RPC method names that actually cross to the runtime, NOT the
 * user-facing API. `table.count()` arrives here as `query` with `'count'` as
 * its third argument; there is no `count` operation. Listing one would make a
 * hook that never fires — a silent no-op, which is worse than an error.
 */
export type OperationName =
  | 'open' | 'get' | 'bulkGet' | 'query'
  | 'add' | 'put' | 'update' | 'upsert' | 'delete' | 'clear'
  | 'bulkAdd' | 'bulkPut' | 'bulkUpdate' | 'bulkDelete'
  | 'deleteWhere' | 'modifyWhere' | 'batch'
  | 'exportTable' | 'importTable';

/** The read modes `query` can be asked for, in `args[2]`. */
export type QueryMode = 'docs' | 'keys' | 'count' | 'indexKeys' | 'uniqueIndexKeys';

export interface OperationContext {
  readonly op: OperationName;
  /** Undefined for database-wide operations. */
  readonly table?: string;
  /** Mutable: a `before` hook may rewrite the arguments. */
  args: unknown[];
}

export interface PluginContext {
  /** Runs before the call leaves the client. Return a value to short-circuit. */
  before(fn: (ctx: OperationContext) => void | unknown | Promise<void | unknown>): void;
  /** Runs after the call resolves. Return a value to replace the result. */
  after(fn: (ctx: OperationContext, result: unknown) => void | unknown | Promise<void | unknown>): void;
  registerStorage(plugin: StoragePlugin): void;
  registerRuntime(plugin: RuntimePlugin): void;
  /** Called when the plugin is removed or the database closes. */
  onDispose(fn: () => void | Promise<void>): void;
}

export interface LitiePlugin {
  readonly name: string;
  /** Return a disposer, or register one with `ctx.onDispose`. */
  setup(ctx: PluginContext): void | (() => void);
}

/** What `db.use()` returns, so a plugin can be removed again at runtime. */
export interface PluginHandle {
  readonly name: string;
  dispose(): Promise<void>;
}
