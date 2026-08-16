import type { LeaderClient } from 'opfs-leader';

export { LeaderLostError, NoLeaderError } from 'opfs-leader';

export declare class VersionError extends Error {
  readonly name: 'VersionError';
}

export type IndexableValue = string | number | boolean | null;

export interface Subscription {
  unsubscribe(): void;
  readonly closed: boolean;
}

export interface Observer<T> {
  next?: (value: T) => void;
  error?: (err: unknown) => void;
}

export interface Observable<T> {
  subscribe(next: (value: T) => void, error?: (err: unknown) => void): Subscription;
  subscribe(observer: Observer<T>): Subscription;
}

export declare class Collection<T = any, K = any> {
  readonly db: Litie;
  /** Union: adds a second OR group. */
  or(index: string): WhereClause<T, K>;
  /** JS predicate — runs client-side after fetching. */
  filter(fn: (doc: T) => boolean): Collection<T, K>;
  /** Alias of {@link filter}. */
  and(fn: (doc: T) => boolean): Collection<T, K>;

  limit(n: number): Collection<T, K>;
  offset(n: number): Collection<T, K>;
  reverse(): Collection<T, K>;
  /** Descending regardless of the current direction. */
  desc(): Collection<T, K>;
  /**
   * No-op: our multiEntry compiles to an IN-subquery which never duplicates rows.
   * Kept so code migrated from Dexie runs unchanged.
   */
  distinct(): Collection<T, K>;
  /** Stop at the first doc matching `fn` (client-side, as in Dexie). */
  until(fn: (doc: T) => boolean, includeStopEntry?: boolean): Collection<T, K>;

  /** Dexie contract: resolves to a sorted ARRAY, not a Collection. */
  sortBy(keyPath: string): Promise<T[]>;
  /** Chainable ordering (not a Dexie member). */
  orderBy(index: string): Collection<T, K>;

  toArray(): Promise<T[]>;
  count(): Promise<number>;
  primaryKeys(): Promise<K[]>;
  /** The INDEX keys of the bound index — not the primary keys. */
  keys(): Promise<IndexableValue[]>;
  uniqueKeys(): Promise<IndexableValue[]>;
  firstKey(): Promise<IndexableValue | undefined>;
  lastKey(): Promise<IndexableValue | undefined>;
  first(): Promise<T | undefined>;
  last(): Promise<T | undefined>;
  each(fn: (doc: T) => void): Promise<void>;
  eachKey(fn: (key: IndexableValue) => void): Promise<void>;
  eachUniqueKey(fn: (key: IndexableValue) => void): Promise<void>;
  eachPrimaryKey(fn: (key: K) => void): Promise<void>;

  delete(): Promise<number>;
  /**
   * Object form compiles to one json_patch UPDATE.
   * Function form reads, applies `fn`, and writes back in one atomic batch;
   * set `ctx.value = undefined` to delete the row, as in Dexie.
   */
  modify(changes: Partial<T> | Record<string, unknown>): Promise<number>;
  modify(fn: (this: { value: T }, doc: T, ctx: { value: T | undefined }) => void): Promise<number>;
}

export declare class WhereClause<T = any, K = any> {
  readonly db: Litie;
  readonly Collection: typeof Collection;
  /** On a compound index, pass the tuple as an array. */
  equals(value: IndexableValue | IndexableValue[]): Collection<T, K>;
  notEqual(value: IndexableValue): Collection<T, K>;
  above(value: IndexableValue): Collection<T, K>;
  aboveOrEqual(value: IndexableValue): Collection<T, K>;
  below(value: IndexableValue): Collection<T, K>;
  belowOrEqual(value: IndexableValue): Collection<T, K>;
  startsWith(prefix: string): Collection<T, K>;
  startsWithIgnoreCase(prefix: string): Collection<T, K>;
  equalsIgnoreCase(value: string): Collection<T, K>;
  anyOf(values: IndexableValue[]): Collection<T, K>;
  anyOf(...values: IndexableValue[]): Collection<T, K>;
  anyOfIgnoreCase(values: string[]): Collection<T, K>;
  anyOfIgnoreCase(...values: string[]): Collection<T, K>;
  startsWithAnyOf(prefixes: string[]): Collection<T, K>;
  startsWithAnyOf(...prefixes: string[]): Collection<T, K>;
  startsWithAnyOfIgnoreCase(prefixes: string[]): Collection<T, K>;
  startsWithAnyOfIgnoreCase(...prefixes: string[]): Collection<T, K>;
  noneOf(values: IndexableValue[]): Collection<T, K>;
  noneOf(...values: IndexableValue[]): Collection<T, K>;
  between(
    lower: IndexableValue,
    upper: IndexableValue,
    includeLower?: boolean,
    includeUpper?: boolean
  ): Collection<T, K>;
  inAnyRange(ranges: Array<[IndexableValue, IndexableValue]>): Collection<T, K>;
  isNull(): Collection<T, K>;
  notNull(): Collection<T, K>;
}

export interface TableSchema {
  name: string;
  primKey: { name: string; keyPath: string; auto: boolean; unique: boolean; multi: boolean; compound: boolean; src: string };
  indexes: Array<{ name: string; keyPath: string | string[]; unique: boolean; multi: boolean; compound: boolean; src: string }>;
}

export type HookName = 'creating' | 'reading' | 'updating' | 'deleting';

export declare class Table<T = any, K = any> {
  readonly name: string;
  readonly db: Litie;
  readonly schema: TableSchema;

  get(key: K): Promise<T | undefined>;
  /** One round trip. Order is preserved; missing keys yield undefined. */
  bulkGet(keys: K[]): Promise<Array<T | undefined>>;

  add(doc: T): Promise<K>;
  put(doc: T): Promise<K>;
  bulkAdd(docs: T[]): Promise<K[]>;
  bulkPut(docs: T[]): Promise<K[]>;
  update(key: K, changes: Partial<T> | Record<string, unknown>): Promise<number>;
  /** Insert if absent, merge-patch if present. */
  upsert(key: K, changes: Partial<T> | Record<string, unknown>): Promise<K>;
  bulkUpdate(ops: Array<{ key: K; changes: Partial<T> | Record<string, unknown> }>): Promise<number>;
  delete(key: K): Promise<number>;
  bulkDelete(keys: K[]): Promise<number[]>;
  clear(): Promise<number>;
  offset(n: number): Collection<T, K>;

  /**
   * Dexie-compatible hooks, run CLIENT-SIDE around the RPC. They are not inside
   * the same SQLite statement as the write, so a hook cannot veto a committed write.
   */
  hook(name: 'creating', fn: (primKey: K, obj: T) => void): this;
  hook(name: 'reading', fn: (obj: T) => T): this;
  hook(name: 'updating', fn: (mods: Record<string, unknown>, primKey: K, obj: T) => Record<string, unknown> | void): this;
  hook(name: 'deleting', fn: (primKey: K, obj: T) => void): this;
  mapToClass<C extends new (...args: any[]) => any>(Class: C): C;

  where(index: string): WhereClause<T, K>;
  /** Multi-index equality, AND'ed. */
  where(criteria: Record<string, IndexableValue>): Collection<T, K>;
  orderBy(index: string): Collection<T, K>;
  filter(fn: (doc: T) => boolean): Collection<T, K>;
  limit(n: number): Collection<T, K>;
  reverse(): Collection<T, K>;
  toCollection(): Collection<T, K>;
  toArray(): Promise<T[]>;
  count(): Promise<number>;
  each(fn: (doc: T) => void): Promise<void>;
}

/** Records writes inside a transaction; results come back from `transaction()`. */
export interface TxTable<T = any, K = any> {
  add(doc: T): this;
  put(doc: T): this;
  bulkAdd(docs: T[]): this;
  bulkPut(docs: T[]): this;
  update(key: K, changes: Partial<T> | Record<string, unknown>): this;
  delete(key: K): this;
  bulkDelete(keys: K[]): this;
  clear(): this;
}

export type TxScope = Record<string, TxTable> & { table(name: string): TxTable };

export interface LitieOptions {
  /** Factory for the dedicated worker. Called only in the elected tab. */
  worker: () => Worker;
  /** Milliseconds to wait for a leader before failing. Default 5000. */
  timeoutMs?: number;
}

export interface OpenResult {
  version: number;
  from: number;
  migrated: boolean;
  statements?: number;
  schema: Record<string, { primKey: { name: string; auto: boolean }; indexes: string[] }>;
}

export interface LiveQueryOptions {
  /** Restrict invalidation to these tables. Auto-detected when omitted. */
  tables?: string[];
  debounceMs?: number;
}

export declare class Litie {
  constructor(name: string, opts: LitieOptions);

  readonly name: string;
  readonly tables: Table[];
  /** @internal */
  _client: LeaderClient;

  /** Dexie-style cumulative schema: later versions declare only what changed. */
  version(n: number): { stores(stores: Record<string, string | null>): { upgrade(): never } };

  table<T = any, K = any>(name: string): Table<T, K>;

  readonly verno: number;
  isOpen(): boolean;
  hasBeenClosed(): boolean;
  hasFailed(): boolean;
  on(event: 'ready' | 'versionchange' | 'blocked' | 'close', fn: (...args: any[]) => void): this;
  once(event: 'ready' | 'versionchange' | 'blocked' | 'close', fn: (...args: any[]) => void): this;

  /** Which backend the worker actually got: 'opfs' or 'indexeddb'. */
  storageKind(): Promise<'opfs' | 'indexeddb'>;
  /** Force a checkpoint. No-op on OPFS; persists now on the IndexedDB fallback. */
  flush(): Promise<void>;

  /** Idempotent — safe to call from every tab. */
  open(): Promise<OpenResult>;
  close(): Promise<void>;
  /** Destroys the OPFS file. Not recoverable. */
  deleteDatabase(): Promise<void>;
  /** Dexie spelling of deleteDatabase(). */
  delete(): Promise<void>;

  /**
   * Atomic multi-write. The callback is SYNCHRONOUS and records operations;
   * it cannot read. Holding a transaction open across postMessage round trips
   * would make commit state unknowable if the leader tab died.
   */
  transaction<R = unknown[]>(fn: (tx: TxScope) => void): Promise<R>;
  /**
   * Dexie-compatible interactive transaction: `fn` is async and CAN read.
   * Holds an exclusive cross-tab Web Lock and a real SQLite transaction.
   */
  transaction<R>(mode: 'r' | 'rw' | 'r!' | 'rw!', ...tablesThenFn: any[]): Promise<R>;

  /** Re-runs `querier` on change, emitting only when the result differs. */
  liveQuery<T>(querier: () => Promise<T>, opts?: LiveQueryOptions): Observable<T>;

  /** Raw change events. `liveQuery` is usually what you want. */
  onChange(fn: (tables: string[]) => void): () => void;
}

export declare function liveQuery<T>(
  db: Litie,
  querier: () => Promise<T>,
  opts?: LiveQueryOptions
): Observable<T>;

export default Litie;

/** Back-compat alias from the pre-1.0 `litie` name. */

/** Neutral alias, for code that prefers a generic name. */
export { Litie as Database };
