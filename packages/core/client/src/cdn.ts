/**
 * `granthdb/cdn` — run from a CDN with no build step and no files of your own.
 *
 *     import { Granth, cdnWorker } from 'https://esm.sh/granthdb';
 *
 *     const db = new Granth('myapp', { worker: cdnWorker() });
 *     db.version(1).stores({ friends: '++id, name, age' });
 *     await db.friends.add({ name: 'Ada', age: 36 });
 *
 * WHY THIS HAS TO EXIST. A Worker script must be same-origin: passing a CDN URL
 * straight to `new Worker()` throws `SecurityError`, verified rather than
 * assumed. So from a CDN the ordinary setup — write a `db.worker.js`, point a
 * `new URL(...)` at it — needs a file you are hosting, which is exactly what
 * someone reaching for a CDN is trying to avoid.
 *
 * The way through is a Blob: a blob: URL counts as same-origin, and a module
 * worker created from one may still `import` across origins. That is a real
 * trick, and not one anybody should have to discover to get started. So it is
 * done here.
 *
 * WHAT YOU GIVE UP: nothing functionally — this path reaches OPFS and was
 * measured doing so. What you take on is a runtime dependency on a third-party
 * CDN, which is a poor trade for production. Install the package for that.
 */

/** Storage backends, in the order they should be tried. */
export type CdnStorage = 'opfs' | 'indexeddb' | 'memory';

export interface CdnWorkerOptions {
  /** CDN origin. Must rewrite bare specifiers — esm.sh and jsDelivr's `+esm` do; unpkg does not. */
  from?: string;
  /**
   * Version to pull. Defaults to the one this module was itself loaded from, so
   * the worker cannot silently run a different build than the client driving it.
   */
  version?: string;
  /** OPFS path / storage key. */
  filename?: string;
  /** Tried in order; the first one available wins. */
  storage?: CdnStorage[];
  /** Pinned sqlite-wasm build. */
  sqliteVersion?: string;
}

/**
 * The version this file was served as, read out of its own URL.
 *
 * Pinning matters more here than it looks: the client and the worker are two
 * separate module graphs, so left to `latest` they could be fetched minutes
 * apart and end up on different builds, with the mismatch showing up as a
 * confusing RPC error rather than as a version problem.
 */
function selfVersion(): string {
  const m = /granthdb@([^/]+)/.exec(import.meta.url);
  return m?.[1] ?? 'latest';
}

const PLUGIN = {
  opfs: 'granth-storage-opfs',
  indexeddb: 'granth-storage-indexeddb',
  memory: 'granth-storage-memory',
} as const;

const FACTORY = {
  opfs: 'opfsStorage',
  indexeddb: 'indexeddbStorage',
  memory: 'memoryStorage',
} as const;

/**
 * Build a worker factory suitable for `new Granth(name, { worker })`.
 *
 * Returns a function rather than a Worker: the client decides when to start one,
 * and may need to start another after `deleteDatabase()`.
 */
export function cdnWorker(options: CdnWorkerOptions = {}): () => Worker {
  const {
    from = 'https://esm.sh',
    version = selfVersion(),
    filename = '/granth.sqlite3',
    storage = ['opfs', 'indexeddb', 'memory'],
    sqliteVersion = '3.53.0-build1',
  } = options;

  if (!storage.length) throw new Error('granthdb: cdnWorker() needs at least one storage backend');
  for (const s of storage) {
    if (!(s in PLUGIN)) {
      throw new Error(`granthdb: unknown storage "${s}" — expected opfs, indexeddb or memory`);
    }
  }

  const base = from.replace(/\/+$/, '');
  const imports = storage
    .map((s) => `import { ${FACTORY[s]} } from '${base}/${PLUGIN[s]}@${version}';`)
    .join('\n');
  const list = storage.map((s) => `${FACTORY[s]}()`).join(', ');

  const source = `
import sqlite3InitModule from '${base}/@sqlite.org/sqlite-wasm@${sqliteVersion}';
import { startGranthWorker } from '${base}/granthdb@${version}/worker';
${imports}
startGranthWorker({
  sqlite3InitModule,
  filename: ${JSON.stringify(filename)},
  storage: [${list}],
});
`.trim();

  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  return () => new Worker(url, { type: 'module' });
}
