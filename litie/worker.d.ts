import type { Engine } from './engine.js';

export interface StartWorkerOptions {
  /** The default export of '@sqlite.org/sqlite-wasm'. */
  sqlite3InitModule: () => Promise<any>;
  /** OPFS path. Default '/litie.sqlite3'. */
  filename?: string;
  /**
   * Data transforms keyed by the version being upgraded TO, run after the
   * schema migration crosses that version. They live here rather than in the
   * client because a function cannot cross postMessage.
   */
  upgrades?: Record<number, (engine: Engine) => void>;
  /** Extra PRAGMAs applied at open, e.g. { synchronous: 'NORMAL' }. */
  pragmas?: Record<string, string | number>;
  scope?: any;
}

/**
 * Boot the database worker. Registers its message listener synchronously and
 * queues calls until setup finishes, so nothing is dropped or hung.
 */
export declare function startLitieWorker(opts: StartWorkerOptions): Promise<void>;

export declare function sqliteWasmAdapter(sqlite3: any, db: any): {
  all(sql: string, params?: unknown[]): any[];
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number };
};

/** Back-compat alias from the pre-1.0 `litie` name. */

/** Neutral alias, for code that prefers a generic name. */
export { startLitieWorker as startDatabaseWorker };
