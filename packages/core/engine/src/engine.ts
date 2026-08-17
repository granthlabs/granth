// The storage engine. Environment-agnostic: give it an adapter with
// {all, run, exec} and it works on sqlite-wasm in a worker OR node:sqlite in a
// test. That is the whole reason this is testable against real SQLite offline.

import {
  parseSchema,
  deletedStores,
  createStoreSql,
  createIndexSql,
  dropStoreSql,
  col,
  jsonPath,
  quoteIdent as q,
  shadowTable,
} from './schema.js';
import { compile, compileDelete, compileModify, boundIndex } from './plan.js';
import type { QueryPlan, QueryMode } from './plan.js';
import type { StoreDef, StoresSpec, IndexDef } from './schema.js';
import { encode, decode, encodeValue, expandPaths } from './codec.js';

export interface Adapter {
  all(sql: string, params?: unknown[]): Array<Record<string, unknown>>;
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

export interface VersionSpec {
  version: number;
  stores: StoresSpec;
}

export interface MigrateResult {
  version: number;
  from: number;
  migrated: boolean;
  statements?: number;
}

export interface BatchOp {
  op: string;
  table: string;
  args: unknown[];
}

export type Doc = Record<string, unknown>;

export class VersionError extends Error {
  constructor(found: number, wanted: number) {
    super(
      `granth: database is at version ${found}, this code declares ${wanted}. ` +
        `Another tab is probably running a newer build — reload.`
    );
    this.name = 'VersionError';
  }
}

/** Dexie semantics: each version declares only what changed; earlier stores carry over. */
export function schemaAt(versions: VersionSpec[], upto: number): Record<string, StoreDef> {
  const merged: StoresSpec = {};
  for (const v of [...versions].sort((a, b) => a.version - b.version)) {
    if (v.version > upto) break;
    for (const [table, spec] of Object.entries(v.stores)) {
      if (spec === null) delete merged[table];
      else merged[table] = spec;
    }
  }
  return parseSchema(merged);
}

const indexKey = (ix: IndexDef): string => `${ix.unique ? '&' : ''}${ix.multi ? '*' : ''}${ix.name}`;

export function createEngine(adapter: Adapter) {
  let stores: Record<string, StoreDef> = {};
  let inTx = false;
  let txStartedAt = 0;
  const now = () => Date.now();
  /**
   * How long an interactive transaction may stay open before it is treated as
   * abandoned. Only reached when the driving tab died: a live transaction is
   * driven across round trips and commits or rolls back. Dexie transactions are
   * meant to be short-lived, so this is generous.
   */
  const txMaxMs = 30_000;

  const store = (table: string): StoreDef => {
    const s = stores[table];
    if (!s) throw new Error(`granth: no table "${table}". Declared: ${Object.keys(stores).join(', ') || '(none)'}`);
    return s;
  };

  const hydrate = (s: StoreDef, row: Record<string, unknown>): Doc => {
    const doc = decode(JSON.parse(String(row['_doc']))) as Doc;
    doc[s.primKey.name] = row[s.primKey.name]; // the key lives in the column, not the JSON
    return doc;
  };

  /** Key in the column, everything else in _doc. One source of truth for the key. */
  const split = (s: StoreDef, doc: unknown): { key: unknown; body: string } => {
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc))
      throw new Error(`granth: "${s.table}" documents must be plain objects`);
    const { [s.primKey.name]: key, ...rest } = doc as Doc;
    if (key === undefined && !s.primKey.auto)
      throw new Error(`granth: "${s.table}" requires a "${s.primKey.name}" (schema has no ++)`);
    // Encode only a PRESENT key: `undefined` must stay undefined so the caller
    // can pick the auto-increment INSERT, not bind a sentinel into an INTEGER PK.
    return {
      key: key === undefined ? undefined : encodeValue(key),
      body: JSON.stringify(encode(rest)),
    };
  };

  function insert(table: string, doc: unknown, mode: 'add' | 'put'): unknown {
    const s = store(table);
    const { key, body } = split(s, doc);
    const t = q(table);
    const pk = q(s.primKey.name);

    // put() must upsert on the PRIMARY KEY only. `INSERT OR REPLACE` resolved ANY
    // uniqueness conflict by DELETING the conflicting row, so putting a doc whose
    // unique index collided with a different row silently destroyed that row —
    // no error, no way to notice. Dexie raises ConstraintError instead.
    //
    // The explicit upsert also fixes multiEntry drift: REPLACE's internal delete
    // does not fire AFTER DELETE triggers unless recursive_triggers is on, so the
    // old shadow rows survived and queries returned documents that no longer had
    // the tag. DO UPDATE fires AFTER UPDATE, which maintains the shadow correctly.
    const onConflict = ` ON CONFLICT(${pk}) DO UPDATE SET "_doc" = excluded."_doc"`;
    const info =
      key === undefined
        // No key supplied: auto-increment, so there is nothing to conflict on.
        ? adapter.run(`INSERT INTO ${t}("_doc") VALUES (?)`, [body])
        : adapter.run(
            `INSERT INTO ${t}(${pk}, "_doc") VALUES (?, ?)${mode === 'put' ? onConflict : ''}`,
            [key, body]
          );
    return key === undefined ? Number(info.lastInsertRowid) : key;
  }

  const CHUNK = 200;

  function bulkInsert(table: string, docs: unknown[], mode: 'add' | 'put'): unknown[] {
    if (!docs.length) return [];
    const s = store(table);
    const t = q(table);
    const pk = q(s.primKey.name);
    const onConflict = ` ON CONFLICT(${pk}) DO UPDATE SET "_doc" = excluded."_doc"`;
    const split_ = docs.map((d) => split(s, d));

    // Mixed shapes in one call: rows WITH a key and rows without cannot share a
    // statement, so fall back rather than guess. Rare, and correctness first.
    const anyKeyed = split_.some((x) => x.key !== undefined);
    const allKeyed = split_.every((x) => x.key !== undefined);
    if (anyKeyed && !allKeyed) {
      return api.batch(docs.map((d) => ({ op: mode, table, args: [d] })));
    }

    const out: unknown[] = [];
    const runChunks = () => {
      for (let i = 0; i < split_.length; i += CHUNK) {
        const chunk = split_.slice(i, i + CHUNK);
        if (allKeyed) {
          const values = chunk.map(() => '(?, ?)').join(', ');
          const params = chunk.flatMap((x) => [x.key, x.body]);
          adapter.run(
            `INSERT INTO ${t}(${pk}, "_doc") VALUES ${values}${mode === 'put' ? onConflict : ''}`,
            params
          );
          for (const x of chunk) out.push(x.key);
        } else {
          const values = chunk.map(() => '(?)').join(', ');
          const info = adapter.run(
            `INSERT INTO ${t}("_doc") VALUES ${values}`,
            chunk.map((x) => x.body)
          );
          const last = Number(info.lastInsertRowid);
          for (let k = chunk.length - 1; k >= 0; k--) out.push(last - k);
        }
      }
    };

    // One transaction for the whole call, as before: a partial bulk insert is
    // worse than a failed one.
    const nested = inTx;
    if (!nested) adapter.exec('BEGIN');
    try {
      runChunks();
      if (!nested) adapter.exec('COMMIT');
    } catch (err) {
      if (!nested) { try { adapter.exec('ROLLBACK'); } catch { /* already rolled back */ } }
      throw err;
    }
    return out;
  }

  const api = {
    /** Bring the file up to the newest declared version. Idempotent. */
    migrate(versions: VersionSpec[]): MigrateResult {
      const target = Math.max(...versions.map((v) => v.version));
      const found = Number((adapter.all(`PRAGMA user_version`)[0] as Record<string, unknown>)['user_version']);
      if (found > target) throw new VersionError(found, target);

      const next = schemaAt(versions, target);
      if (found === target) {
        // Same version number, different schema = silent drift. Without this check
        // the new stores() is simply ignored and the app fails much later with
        // "no such table", far from the cause.
        const present = new Set(
          adapter.all(`SELECT name FROM sqlite_master WHERE type IN ('table','index')`).map((r) => String(r['name']))
        );
        const missing: string[] = [];
        for (const [table, st] of Object.entries(next)) {
          if (!present.has(table)) { missing.push(`table "${table}"`); continue; }
          for (const ix of st.indexes) {
            const nm = ix.multi ? shadowTable(st, ix) : `${table}$${ix.name}`;
            if (!present.has(nm)) missing.push(`index "${ix.name}" on "${table}"`);
          }
        }
        if (missing.length) {
          throw new Error(
            `granth: the schema declared for version ${target} does not match the database — ` +
              `missing ${missing.join(', ')}. Schema changes need a NEW version: ` +
              `db.version(${target + 1}).stores({ ... }).`
          );
        }
        stores = next;
        return { version: found, from: found, migrated: false };
      }

      const prev = schemaAt(versions, found);
      const sql: string[] = [];

      for (const table of Object.keys(prev)) {
        if (!next[table]) sql.push(...dropStoreSql(prev[table]));
      }
      for (const [table, s] of Object.entries(next)) {
        if (!prev[table]) {
          sql.push(...createStoreSql(s));
          continue;
        }
        const old = prev[table];
        if (old.primKey.name !== s.primKey.name || old.primKey.auto !== s.primKey.auto) {
          // ponytail: rebuilding a table to change its key is a lot of code for a
          // rare migration. Fail loudly instead of silently keeping the old key.
          throw new Error(
            `granth: cannot change the primary key of "${table}" (${old.primKey.name} -> ${s.primKey.name}). ` +
              `Create a new table and copy in an upgrade step.`
          );
        }
        const oldKeys = new Set(old.indexes.map(indexKey));
        const newKeys = new Set(s.indexes.map(indexKey));
        for (const ix of old.indexes) {
          if (newKeys.has(indexKey(ix))) continue;
          if (ix.multi) sql.push(...dropMultiSql(old, ix));
          else sql.push(`DROP INDEX IF EXISTS ${q(`${table}$${ix.name}`)}`);
        }
        // table_xinfo, NOT table_info: table_info OMITS virtual generated columns,
        // and every index column here is virtual. With table_info this set was
        // always empty, so ALTER TABLE ADD COLUMN was re-emitted for a keyPath an
        // earlier version had already indexed — "duplicate column name" — which
        // rolled the whole migration back. Fresh installs took the CREATE TABLE
        // path and never hit it; every EXISTING database was bricked.
        const existing = new Set(adapter.all(`PRAGMA table_xinfo(${q(table)})`).map((r) => String(r['name'])));
        for (const ix of s.indexes) {
          if (oldKeys.has(indexKey(ix))) continue;
          if (!ix.multi) {
            // Virtual generated columns can be added with ALTER TABLE. STORED cannot —
            // that is why schema.js emits VIRTUAL.
            for (const kp of ix.keyPaths) {
              if (kp === s.primKey.name || existing.has(col(kp))) continue;
              existing.add(col(kp));
              sql.push(
                `ALTER TABLE ${q(table)} ADD COLUMN ${q(col(kp))} ` +
                  `GENERATED ALWAYS AS (json_extract("_doc", '${jsonPath(kp)}')) VIRTUAL`
              );
            }
          }
          sql.push(...createIndexSql(s, ix));
        }
      }

      adapter.exec('BEGIN');
      try {
        for (const stmt of sql) adapter.exec(stmt);
        adapter.exec(`PRAGMA user_version = ${target}`);
        adapter.exec('COMMIT');
      } catch (err) {
        // SQLite auto-rolls back on some errors, so ROLLBACK can itself throw
        // "no transaction is active" — which would replace the real cause and
        // make every failure look identical. Never let cleanup mask the error.
        try { adapter.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw err;
      }
      stores = next;
      return { version: target, from: found, migrated: true, statements: sql.length };
    },

    schema: () =>
      Object.fromEntries(
        Object.entries(stores).map(([t, s]) => [
          t,
          { primKey: s.primKey, indexes: s.indexes.map((i) => i.name) },
        ])
      ),

    add: (table: string, doc: unknown) => insert(table, doc, 'add'),
    put: (table: string, doc: unknown) => insert(table, doc, 'put'),
    /**
     * Bulk insert as CHUNKED MULTI-ROW statements, not one INSERT per document.
     *
     * Measured: 5,000 docs took 5,002 adapter calls and ~131 ms as
     * one-statement-per-row. Each call is a prepare + step + reset, and on the
     * worker path each is also a crossing into sqlite-wasm.
     *
     * Chunked at 200 rows because SQLITE_MAX_VARIABLE_NUMBER is 999 on older
     * builds; 200 rows x 2 columns stays well inside that on every build we
     * support, and the returns above ~100 are flat anyway.
     *
     * Auto-increment keys: SQLite assigns consecutive rowids within a single
     * INSERT..VALUES, and we hold the only connection, so the ids are the run
     * ending at lastInsertRowid. There is a test asserting the returned ids are
     * exactly the ids actually stored, because that is an assumption about
     * SQLite's behaviour rather than a documented API.
     */
    bulkAdd: (table: string, docs: unknown[]) => bulkInsert(table, docs, 'add'),
    bulkPut: (table: string, docs: unknown[]) => bulkInsert(table, docs, 'put'),

    get(table: string, key: unknown): Doc | undefined {
      const s = store(table);
      const rows = adapter.all(
        `SELECT ${q(s.primKey.name)}, "_doc" FROM ${q(table)} WHERE ${q(s.primKey.name)} = ?`,
        [encodeValue(key)]
      );
      return rows.length ? hydrate(s, rows[0] as Record<string, unknown>) : undefined;
    },

    /** One statement instead of one round trip per key. Order is preserved; misses are undefined. */
    bulkGet(table: string, keys: unknown[]): Array<Doc | undefined> {
      const s = store(table);
      if (!keys.length) return [];
      const pk = q(s.primKey.name);
      const found = new Map<unknown, Doc>();
      // SQLite caps bound parameters (999 on older builds), so chunk rather than
      // building one giant IN list that fails only on large inputs.
      for (let i = 0; i < keys.length; i += 500) {
        const chunk = keys.slice(i, i + 500).map(encodeValue);
        const ph = chunk.map(() => '?').join(', ');
        for (const row of adapter.all(
          `SELECT ${pk}, "_doc" FROM ${q(table)} WHERE ${pk} IN (${ph})`,
          chunk
        )) {
          found.set(row[s.primKey.name], hydrate(s, row));
        }
      }
      return keys.map((k) => found.get(encodeValue(k)));
    },

    /**
     * Rows exactly as stored — the codec-encoded form, which is JSON-safe by
     * construction. Exporting decoded documents would push Dates and NaN back
     * through JSON.stringify and lose exactly what the codec exists to preserve.
     */
    exportTable(table: string): { primKey: string; auto: boolean; rows: Array<{ k: unknown; d: unknown }> } {
      const st = store(table);
      const pk = st.primKey.name;
      const rows = adapter
        .all(`SELECT ${q(pk)}, "_doc" FROM ${q(table)} ORDER BY ${q(pk)}`)
        .map((r) => ({ k: r[pk], d: JSON.parse(String(r['_doc'])) as unknown }));
      return { primKey: pk, auto: st.primKey.auto, rows };
    },

    /** Counterpart to exportTable. Re-inserts the encoded form untouched. */
    importTable(table: string, rows: Array<{ k: unknown; d: unknown }>): number {
      const st = store(table);
      const t = q(table);
      const pk = q(st.primKey.name);
      return api.batchRaw(() => {
        for (const { k, d } of rows) {
          adapter.run(`INSERT OR REPLACE INTO ${t}(${pk}, "_doc") VALUES (?, ?)`, [k, JSON.stringify(d)]);
        }
        return rows.length;
      });
    },

    /** Run `fn` inside a transaction, joining an outer one if present. */
    batchRaw<T>(fn: () => T): T {
      const nested = inTx;
      if (!nested) adapter.exec('BEGIN');
      try {
        const out = fn();
        if (!nested) adapter.exec('COMMIT');
        return out;
      } catch (err) {
        // See migrate(): cleanup must never mask the original failure.
        if (!nested) { try { adapter.exec('ROLLBACK'); } catch { /* already rolled back */ } }
        throw err;
      }
    },

    /** Dexie's upsert(key, changes): insert if absent, merge-patch if present. */
    upsert(table: string, key: unknown, changes: Doc): unknown {
      const s = store(table);
      const { [s.primKey.name]: _drop, ...rest } = changes;
      const body = JSON.stringify(encode(expandPaths(rest)));
      adapter.run(
        `INSERT INTO ${q(table)}(${q(s.primKey.name)}, "_doc") VALUES (?, ?) ` +
          `ON CONFLICT(${q(s.primKey.name)}) DO UPDATE SET "_doc" = json_patch("_doc", ?)`,
        [encodeValue(key), body, body]
      );
      return key;
    },

    bulkUpdate: (table: string, ops: Array<{ key: unknown; changes: Doc }>) =>
      api.batch(ops.map(({ key, changes }) => ({ op: 'update', table, args: [key, changes] }))),

    update(table: string, key: unknown, changes: Doc): number {
      const s = store(table);
      const { [s.primKey.name]: _ignored, ...rest } = changes;
      const info = adapter.run(
        `UPDATE ${q(table)} SET "_doc" = json_patch("_doc", ?) WHERE ${q(s.primKey.name)} = ?`,
        [JSON.stringify(encode(expandPaths(rest))), encodeValue(key)]
      );
      return info.changes;
    },

    delete(table: string, key: unknown): number {
      const s = store(table);
      return adapter.run(`DELETE FROM ${q(table)} WHERE ${q(s.primKey.name)} = ?`, [encodeValue(key)]).changes;
    },

    bulkDelete: (table: string, keys: unknown[]) => api.batch(keys.map((k) => ({ op: 'delete', table, args: [k] }))),

    clear(table: string): number {
      store(table);
      return adapter.run(`DELETE FROM ${q(table)}`, []).changes;
    },

    query(table: string, plan: QueryPlan, mode: QueryMode = 'docs'): unknown {
      const s = store(table);
      const { sql, params } = compile(s, plan, mode);
      const rows = adapter.all(sql, params);
      if (mode === 'count') return Number((rows[0] as Record<string, unknown>)['n']);
      if (mode === 'keys') return rows.map((r) => r[s.primKey.name]);
      if (mode === 'indexKeys' || mode === 'uniqueIndexKeys') {
        const ix = boundIndex(s, plan);
        const compound = s.indexes.find((i) => i.name === ix)?.compound;
        // Compound keys come back as a JSON array so the tuple survives SQL.
        return rows.map((r) => (compound ? JSON.parse(String(r['k'])) : r['k']));
      }
      return rows.map((r) => hydrate(s, r));
    },

    deleteWhere(table: string, plan: QueryPlan): number {
      const { sql, params } = compileDelete(store(table), plan);
      return adapter.run(sql, params).changes;
    },

    modifyWhere(table: string, plan: QueryPlan, changes: object): number {
      const { sql, params } = compileModify(store(table), plan, changes);
      return adapter.run(sql, params).changes;
    },

    /**
     * Interactive transaction support. The leader worker holds ONE open SQLite
     * transaction; the client drives it across round trips.
     *
     * THE HAZARD, stated honestly: the transaction lives in the LEADER's worker,
     * but it is driven by whichever tab called transaction() — possibly a
     * follower. If that tab dies between txBegin and txCommit, nothing rolls it
     * back. An earlier version of this comment claimed the client sent
     * txRollback on close and that the worker capped transaction lifetime.
     * Neither was true. The damage was severe and silent: every later write from
     * every tab was acknowledged, was readable, executed INSIDE the abandoned
     * transaction, and then vanished when the connection finally rolled back —
     * while every future txBegin threw "already open" forever.
     *
     * Two real mitigations now:
     *  - `force`, which the client passes because it holds the EXCLUSIVE
     *    cross-tab lock at that point. The browser releases a dead tab's Web
     *    Lock, so holding it proves no live tab owns a transaction.
     *  - a lease (`txMaxMs`), which covers the case where no new transaction is
     *    ever started and ordinary writes would otherwise be swallowed.
     */
    txBegin(mode: 'r' | 'rw' = 'rw', force = false): boolean {
      if (inTx && !force) throw new Error('granth: a transaction is already open on this connection');
      // Defensive: clears both a stale flag and any transaction SQLite still has
      // open. Unlike before, this is now REACHABLE when inTx is set, which is
      // exactly when it is needed.
      inTx = false;
      try { adapter.exec('ROLLBACK'); } catch { /* nothing was open */ }
      adapter.exec(mode === 'r' ? 'BEGIN' : 'BEGIN IMMEDIATE');
      inTx = true;
      txStartedAt = now();
      return true;
    },

    /**
     * Roll back a transaction whose owner is gone, so its writes cannot be
     * silently absorbed. Returns true if it actually reaped one.
     */
    reapStaleTx(): boolean {
      if (!inTx || now() - txStartedAt < txMaxMs) return false;
      inTx = false;
      try { adapter.exec('ROLLBACK'); } catch { /* already gone */ }
      return true;
    },
    txCommit(): boolean {
      if (!inTx) throw new Error('granth: no transaction is open');
      // Clear before committing: if COMMIT throws, the transaction is gone
      // anyway and leaving the flag set would wedge the connection.
      inTx = false;
      adapter.exec('COMMIT');
      return true;
    },
    txRollback(): boolean {
      if (!inTx) return false;
      // `inTx` is our belief; SQLite may already have rolled back on its own
      // after an error. Clear the flag either way, or the connection is wedged
      // for every later call — which is how one failure became "cannot rollback"
      // on every subsequent operation.
      inTx = false;
      try { adapter.exec('ROLLBACK'); } catch { /* already rolled back */ }
      return true;
    },
    get inTransaction() {
      return inTx;
    },

    /**
     * Atomically apply a recorded list of writes.
     * ponytail: a batch, not an interactive transaction. Holding a real transaction
     * open across postMessage round-trips is precisely the "leader died mid-transaction,
     * caller cannot know if it committed" hazard — see LeaderLostError in opfs-leader.
     */
    batch(ops: BatchOp[]): unknown[] {
      // SQLite has no nested transactions; if one is already open, just run inside it.
      const nested = inTx;
      if (!nested) adapter.exec('BEGIN');
      try {
        const out = ops.map(({ op, table, args }) => {
          const fn = (api as unknown as Record<string, unknown>)[op];
          if (typeof fn !== 'function' || op === 'batch' || op === 'migrate')
            throw new Error(`granth: "${op}" is not allowed in a transaction`);
          return (fn as (...a: unknown[]) => unknown)(table, ...args);
        });
        if (!nested) adapter.exec('COMMIT');
        return out;
      } catch (err) {
        // See migrate(): cleanup must never mask the original failure.
        if (!nested) { try { adapter.exec('ROLLBACK'); } catch { /* already rolled back */ } }
        throw err;
      }
    },
  };

  function dropMultiSql(s: StoreDef, ix: IndexDef): string[] {
    const sh = shadowTable(s, ix);
    return [
      `DROP TRIGGER IF EXISTS ${q(sh + '$ai')}`,
      `DROP TRIGGER IF EXISTS ${q(sh + '$ad')}`,
      `DROP TRIGGER IF EXISTS ${q(sh + '$au')}`,
      `DROP TABLE IF EXISTS ${q(sh)}`,
    ];
  }

  return api;
}

/**
 * The RPC surface the client talks to, defined ONCE.
 * Both the real worker and the test harness build their handlers from this —
 * two hand-maintained copies drifted and shipped a missing `bulkGet`.
 *
 * @param {() => object} getEngine  resolved per call, so the worker can swap the
 *                                  engine (deleteDatabase reopens the file).
 */
export type Engine = ReturnType<typeof createEngine>;

export function rpcHandlers(
  getEngine: () => Engine,
  { onMigrated }: { onMigrated?: (result: MigrateResult, engine: Engine) => void } = {}
): Record<string, (...args: never[]) => unknown> {
  const E = getEngine;

  /**
   * Every RPC first reaps an abandoned transaction.
   *
   * A tab that dies between txBegin and txCommit leaves the leader's connection
   * mid-transaction. Without this, ordinary writes from OTHER tabs execute
   * inside it — acknowledged, readable, then destroyed when the connection
   * finally rolls back. Reaping here means the worst case is a rolled-back
   * transaction rather than silently discarded writes.
   */
  const reap = <T>(fn: () => T): T => { E().reapStaleTx(); return fn(); };

  return {
    open(versions: VersionSpec[]) {
      const result = E().migrate(versions);
      if (result.migrated) onMigrated?.(result, E());
      return { ...result, schema: E().schema() };
    },
    get: (t: string, k: unknown) => reap(() => E().get(t, k)),
    bulkGet: (t: string, keys: unknown[]) => reap(() => E().bulkGet(t, keys)),
    exportTable: (t: string) => E().exportTable(t),
    importTable: (t: string, rows: Array<{ k: unknown; d: unknown }>) => E().importTable(t, rows),
    upsert: (t: string, k: unknown, c: Doc) => reap(() => E().upsert(t, k, c)),
    bulkUpdate: (t: string, ops: Array<{ key: unknown; changes: Doc }>) => reap(() => E().bulkUpdate(t, ops)),
    txBegin: (_t: unknown, mode: 'r' | 'rw', force?: boolean) => E().txBegin(mode, force),
    txCommit: () => E().txCommit(),
    txRollback: () => E().txRollback(),
    add: (t: string, d: unknown) => reap(() => E().add(t, d)),
    put: (t: string, d: unknown) => reap(() => E().put(t, d)),
    bulkAdd: (t: string, d: unknown[]) => reap(() => E().bulkAdd(t, d)),
    bulkPut: (t: string, d: unknown[]) => reap(() => E().bulkPut(t, d)),
    update: (t: string, k: unknown, c: Doc) => reap(() => E().update(t, k, c)),
    delete: (t: string, k: unknown) => reap(() => E().delete(t, k)),
    bulkDelete: (t: string, k: unknown[]) => reap(() => E().bulkDelete(t, k)),
    clear: (t: string) => reap(() => E().clear(t)),
    query: (t: string, plan: QueryPlan, mode: QueryMode) => reap(() => E().query(t, plan, mode)),
    deleteWhere: (t: string, plan: QueryPlan) => reap(() => E().deleteWhere(t, plan)),
    modifyWhere: (t: string, plan: QueryPlan, c: object) => reap(() => E().modifyWhere(t, plan, c)),
    batch: (_table: unknown, ops: BatchOp[]) => E().batch(ops),
  };
}

/** Which tables a call writes to — drives liveQuery invalidation. */
export const WRITES = new Set([
  'add', 'put', 'bulkAdd', 'bulkPut', 'update', 'delete', 'bulkDelete',
  'clear', 'deleteWhere', 'modifyWhere', 'batch',
]);
