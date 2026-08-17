export declare class VersionError extends Error {
  readonly name: 'VersionError';
  constructor(found: number, wanted: number);
}

export interface Adapter {
  all(sql: string, params?: unknown[]): any[];
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

export interface VersionSpec {
  version: number;
  stores: Record<string, string | null>;
}

export interface QueryPlan {
  or: Array<{ and: Array<{ index: string; op: string; values?: unknown[] }> }>;
  order?: { index: string; desc?: boolean } | null;
  offset?: number;
  limit?: number | null;
  reverse?: boolean;
}

export interface MigrateResult {
  version: number;
  from: number;
  migrated: boolean;
  statements?: number;
}

export interface Engine {
  migrate(versions: VersionSpec[]): MigrateResult;
  schema(): Record<string, { primKey: { name: string; auto: boolean }; indexes: string[] }>;
  add(table: string, doc: object): any;
  put(table: string, doc: object): any;
  bulkAdd(table: string, docs: object[]): any[];
  bulkPut(table: string, docs: object[]): any[];
  get(table: string, key: unknown): any;
  bulkGet(table: string, keys: unknown[]): any[];
  update(table: string, key: unknown, changes: object): number;
  delete(table: string, key: unknown): number;
  bulkDelete(table: string, keys: unknown[]): number[];
  clear(table: string): number;
  query(table: string, plan: QueryPlan, mode?: 'docs'): any[];
  query(table: string, plan: QueryPlan, mode: 'keys'): any[];
  query(table: string, plan: QueryPlan, mode: 'count'): number;
  deleteWhere(table: string, plan: QueryPlan): number;
  modifyWhere(table: string, plan: QueryPlan, changes: object): number;
  batch(ops: Array<{ op: string; table: string; args: unknown[] }>): unknown[];
}

/**
 * Environment-agnostic storage engine. Works on sqlite-wasm in a worker and on
 * node:sqlite in a test, which is how the SQL is verified outside a browser.
 */
export declare function createEngine(adapter: Adapter): Engine;

/** The RPC surface, defined once so the worker and test harness cannot drift. */
export declare function rpcHandlers(
  getEngine: () => Engine,
  opts?: { onMigrated?: (result: MigrateResult, engine: Engine) => void }
): Record<string, (...args: any[]) => unknown>;

export declare function schemaAt(versions: VersionSpec[], upto: number): Record<string, unknown>;

export declare const WRITES: Set<string>;
