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
import { compile, compileDelete, compileModify, boundIndex, LOWER } from './plan.js';
import type { QueryPlan, QueryMode } from './plan.js';
import type { StoreDef, StoresSpec, IndexDef } from './schema.js';
import { encode, decode, encodeValue, encodePatch, expandPaths } from './codec.js';

/**
 * A key that cannot belong to this store's primary key at all.
 *
 * SQLite gives an `INTEGER PRIMARY KEY` column integer affinity, so binding the
 * STRING '2' silently became the NUMBER 2 — `get('2')` returned row 2 and
 * `delete('2')` DESTROYED it. IndexedDB keys are typed: '2' and 2 are different
 * keys and a lookup by '2' simply misses. A route param or a localStorage value
 * that stayed a string is the everyday way in.
 *
 * Reads and deletes treat this as a miss, exactly as Dexie does. Writes throw,
 * because silently storing under a different key is the worse answer.
 */
const KEY_MISS = Symbol('granth:key-miss');

const isValidKey = (k: unknown): boolean =>
  typeof k === 'string' || typeof k === 'bigint' || k instanceof Date ||
  (typeof k === 'number' && !Number.isNaN(k));

/**
 * Encode a primary key for binding, or KEY_MISS if this store cannot hold it.
 *
 * An auto-increment key is a rowid alias and can only ever be an integer, so
 * anything else is not a key of this table rather than a key that is absent.
 */
function keyParam(s: StoreDef, key: unknown): unknown {
  if (!isValidKey(key)) {
    throw new Error(
      `granth: ${key === null ? 'null' : typeof key} is not a valid key. ` +
        `Keys must be a string, number, Date or bigint.`
    );
  }
  if (s.primKey.auto && !(typeof key === 'number' && Number.isInteger(key))) return KEY_MISS;
  return encodeValue(key);
}

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

  /**
   * Unicode case folding for the ignore-case operators.
   *
   * SQLite's built-in lower() folds A-Z and nothing else, while the NEEDLE was
   * lowered in JS with full Unicode — so equalsIgnoreCase('ÉCOLE') compared
   * 'école' against an unchanged 'ÉCOLE' and matched only values that were
   * already lowercase. Every non-English search box under-matched in silence.
   *
   * Registered here rather than in each storage plugin so there is one
   * definition, and NOT used in any generated column or index: an expression
   * index over an application function breaks the moment the file is opened by
   * something that has not registered it.
   */
  adapter.createFunction?.(LOWER, (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : v));

  /**
   * Run `fn` with a transaction open, joining an outer one if there is one.
   *
   * `inTx` is the ONE record of whether this connection has a transaction open,
   * so every path that opens one must set it. batch() and batchRaw() issued a
   * bare BEGIN without setting it, so a nested helper believed it was at the top
   * level and issued a second BEGIN — "cannot start a transaction within a
   * transaction", zero rows written. That is why bulkAdd inside the batch form
   * of transaction() always failed while tx.friends.add() in the same form
   * worked: only the bulk helpers open a transaction of their own.
   */
  function inTransaction<T>(fn: () => T): T {
    if (inTx) return fn(); // SQLite has no nested transactions; join this one
    adapter.exec('BEGIN');
    inTx = true;
    txStartedAt = now();
    try {
      const out = fn();
      inTx = false;
      adapter.exec('COMMIT');
      return out;
    } catch (err) {
      // Cleanup must never mask the original failure: SQLite auto-rolls back on
      // some errors, so ROLLBACK can itself throw "no transaction is active".
      inTx = false;
      try { adapter.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  }

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
    if (key === undefined) return { key: undefined, body: JSON.stringify(encode(rest)) };
    const k = keyParam(s, key);
    if (k === KEY_MISS) {
      // Reached the adapter as a bare `datatype mismatch`, which names neither
      // the table nor the reason.
      throw new Error(
        `granth: "${s.table}" has an auto-increment primary key, so "${s.primKey.name}" ` +
          `must be an integer — got ${typeof key === 'string' ? JSON.stringify(key) : String(key)}. ` +
          `Declare the key without ++ to use string keys.`
      );
    }
    return { key: k, body: JSON.stringify(encode(rest)) };
  };

  /**
   * Drop the shadow rows belonging to whichever parent rows `where` selects.
   *
   * This deliberately does NOT live in an AFTER DELETE / AFTER UPDATE trigger,
   * which is the obvious place for it. SQLite does not use an index for the
   * WHERE clause of a DELETE inside a trigger body — it rewinds and scans the
   * whole table (and rejects INDEXED BY there, because no index is being
   * chosen). That made every written row cost a full scan of the shadow table:
   * clearing 100,000 rows took 168 SECONDS, versus 332 ms for the same table
   * without a multiEntry index. Out here the planner uses the index normally
   * and the same work takes ~11 ms.
   *
   * Matched against the shadow's own "k" column, NOT via a subquery over the
   * parent table: `WHERE k IN (SELECT id FROM t WHERE id = ?)` makes SQLite scan
   * the shadow table once per call, which reintroduces the very cost this
   * exists to remove. A literal `k = ?` (or `k IN (?,?,…)`) seeks the index.
   *
   * Callers must run this BEFORE the parent write, while the shadow rows are
   * still the old ones, and inside the same transaction — a purge that outlives
   * a failed delete would hide documents that are still there.
   */
  function purgeShadowKeys(s: StoreDef, keys: unknown[]): void {
    if (!keys.length) return;
    const where = keys.length === 1 ? `= ?` : `IN (${keys.map(() => '?').join(', ')})`;
    for (const ix of s.indexes) {
      if (!ix.multi) continue;
      adapter.run(`DELETE FROM ${q(shadowTable(s, ix))} WHERE "k" ${where}`, keys);
    }
  }

  /** Every shadow row for the store. */
  function purgeShadowsAll(s: StoreDef): void {
    for (const ix of s.indexes) {
      if (!ix.multi) continue;
      adapter.run(`DELETE FROM ${q(shadowTable(s, ix))}`, []);
    }
  }

  /**
   * Purge for a query plan. Here the subquery IS right: one statement covers
   * every matching row, so the shadow is walked once rather than once per row.
   */
  function purgeShadowsForPlan(s: StoreDef, plan: QueryPlan): void {
    if (!s.indexes.some((ix) => ix.multi)) return;
    const inner = compile(s, plan, 'keys');
    for (const ix of s.indexes) {
      if (!ix.multi) continue;
      adapter.run(`DELETE FROM ${q(shadowTable(s, ix))} WHERE "k" IN (${inner.sql})`, inner.params);
    }
  }

  const hasMulti = (s: StoreDef): boolean => s.indexes.some((ix) => ix.multi);

  /**
   * Replace trigger-based shadow maintenance in databases that already exist.
   *
   * Files written by an earlier version still carry the `$ad` trigger and an
   * `$au` that begins with a DELETE — the scanning shape. `CREATE TRIGGER IF NOT
   * EXISTS` will not replace them, so without this the fix only ever reaches new
   * databases, which is the worst case: the users with the most data keep the
   * slowest path. Runs on every open; the detection is one sqlite_master read
   * and it does nothing at all once there is no `$ad` left.
   */
  function retireShadowTriggers(defs: Record<string, StoreDef>): void {
    const present = new Set(
      adapter
        .all(`SELECT name FROM sqlite_master WHERE type = 'trigger'`)
        .map((r) => String(r['name']))
    );
    const sql: string[] = [];
    for (const s of Object.values(defs)) {
      for (const ix of s.indexes) {
        if (!ix.multi) continue;
        const sh = shadowTable(s, ix);
        if (!present.has(`${sh}$ad`)) continue; // already on the new shape
        sql.push(`DROP TRIGGER IF EXISTS ${q(`${sh}$ad`)}`, `DROP TRIGGER IF EXISTS ${q(`${sh}$au`)}`);
        // Everything here is IF NOT EXISTS, so only the dropped $au comes back.
        sql.push(...createIndexSql(s, ix));
      }
    }
    for (const stmt of sql) adapter.exec(stmt);
  }

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
    // the tag. DO UPDATE fires AFTER UPDATE, which refills the shadow.
    const onConflict = ` ON CONFLICT(${pk}) DO UPDATE SET "_doc" = excluded."_doc"`;
    const write = (): unknown => {
      // A put over an existing key REPLACES its array, so the old entries have
      // to go first; the AFTER UPDATE trigger only adds. An `add` cannot
      // overwrite anything, and an auto-increment key cannot collide.
      if (mode === 'put' && key !== undefined && hasMulti(s)) {
        purgeShadowKeys(s, [key]);
      }
      const info =
        key === undefined
          // No key supplied: auto-increment, so there is nothing to conflict on.
          ? adapter.run(`INSERT INTO ${t}("_doc") VALUES (?)`, [body])
          : adapter.run(
              `INSERT INTO ${t}(${pk}, "_doc") VALUES (?, ?)${mode === 'put' ? onConflict : ''}`,
              [key, body]
            );
      return key === undefined ? Number(info.lastInsertRowid) : key;
    };
    return mode === 'put' && key !== undefined && hasMulti(s) ? inTransaction(write) : write();
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
          // Same reason as insert(): put replaces the array, the trigger only adds.
          if (mode === 'put' && hasMulti(s)) {
            purgeShadowKeys(s, chunk.map((x) => x.key));
          }
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

    // One transaction for the whole call: a partial bulk insert is worse than a
    // failed one.
    inTransaction(runChunks);
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
        retireShadowTriggers(next);
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
      retireShadowTriggers(next);
      stores = next;
      return { version: target, from: found, migrated: true, statements: sql.length };
    },

    /**
     * Bytes the database occupies, asked of SQLite rather than of the backend,
     * so it answers the same way on OPFS, IndexedDB and memory alike.
     *
     * This counts pages the file HOLDS, which includes free pages left behind
     * by deletes — the same number the filesystem would report, and not the
     * same as the size of the live data.
     */
    size(): number {
      const r = adapter.all(
        `SELECT (SELECT * FROM pragma_page_count()) * (SELECT * FROM pragma_page_size()) AS bytes`
      )[0];
      return Number(r?.['bytes'] ?? 0);
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
      const k = keyParam(s, key);
      if (k === KEY_MISS) return undefined;
      const rows = adapter.all(
        `SELECT ${q(s.primKey.name)}, "_doc" FROM ${q(table)} WHERE ${q(s.primKey.name)} = ?`,
        [k]
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
      const encoded = keys.map((k) => keyParam(s, k));
      for (let i = 0; i < encoded.length; i += 500) {
        const chunk = encoded.slice(i, i + 500).filter((k) => k !== KEY_MISS);
        if (!chunk.length) continue;
        const ph = chunk.map(() => '?').join(', ');
        for (const row of adapter.all(
          `SELECT ${pk}, "_doc" FROM ${q(table)} WHERE ${pk} IN (${ph})`,
          chunk
        )) {
          found.set(row[s.primKey.name], hydrate(s, row));
        }
      }
      return encoded.map((k) => (k === KEY_MISS ? undefined : found.get(k)));
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
    batchRaw: <T>(fn: () => T): T => inTransaction(fn),

    /** Dexie's upsert(key, changes): insert if absent, merge-patch if present. */
    upsert(table: string, key: unknown, changes: Doc): unknown {
      const s = store(table);
      const k = keyParam(s, key);
      if (k === KEY_MISS) throw new Error(`granth: "${String(key)}" is not a valid key for "${table}"`);
      const { [s.primKey.name]: _drop, ...rest } = changes;
      const expanded = expandPaths(rest);
      // Two bodies, deliberately: on INSERT the changes ARE the document, so
      // `undefined` keeps its sentinel; on UPDATE they are a patch, where
      // undefined means "remove this property".
      const write = (): unknown => {
        if (hasMulti(s)) purgeShadowKeys(s, [k]);
        adapter.run(
          `INSERT INTO ${q(table)}(${q(s.primKey.name)}, "_doc") VALUES (?, ?) ` +
            `ON CONFLICT(${q(s.primKey.name)}) DO UPDATE SET "_doc" = json_patch("_doc", ?)`,
          [k, JSON.stringify(encode(expanded)), JSON.stringify(encodePatch(expanded))]
        );
        return key;
      };
      return hasMulti(s) ? inTransaction(write) : write();
    },

    bulkUpdate: (table: string, ops: Array<{ key: unknown; changes: Doc }>) =>
      api.batch(ops.map(({ key, changes }) => ({ op: 'update', table, args: [key, changes] }))),

    update(table: string, key: unknown, changes: Doc): number {
      const s = store(table);
      const k = keyParam(s, key);
      if (k === KEY_MISS) return 0;
      const { [s.primKey.name]: _ignored, ...rest } = changes;
      const run = (): number => {
        if (hasMulti(s)) purgeShadowKeys(s, [k]);
        return adapter.run(
          `UPDATE ${q(table)} SET "_doc" = json_patch("_doc", ?) WHERE ${q(s.primKey.name)} = ?`,
          [JSON.stringify(encodePatch(expandPaths(rest))), k]
        ).changes;
      };
      return hasMulti(s) ? inTransaction(run) : run();
    },

    delete(table: string, key: unknown): number {
      const s = store(table);
      const k = keyParam(s, key);
      if (k === KEY_MISS) return 0;
      const run = (): number => {
        if (hasMulti(s)) purgeShadowKeys(s, [k]);
        return adapter.run(`DELETE FROM ${q(table)} WHERE ${q(s.primKey.name)} = ?`, [k]).changes;
      };
      return hasMulti(s) ? inTransaction(run) : run();
    },

    bulkDelete: (table: string, keys: unknown[]) => api.batch(keys.map((k) => ({ op: 'delete', table, args: [k] }))),

    clear(table: string): number {
      const s = store(table);
      const run = (): number => {
        if (hasMulti(s)) purgeShadowsAll(s);
        return adapter.run(`DELETE FROM ${q(table)}`, []).changes;
      };
      return hasMulti(s) ? inTransaction(run) : run();
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
      const s = store(table);
      const run = (): number => {
        purgeShadowsForPlan(s, plan);
        const { sql, params } = compileDelete(s, plan);
        return adapter.run(sql, params).changes;
      };
      return hasMulti(s) ? inTransaction(run) : run();
    },

    modifyWhere(table: string, plan: QueryPlan, changes: object): number {
      const s = store(table);
      const run = (): number => {
        purgeShadowsForPlan(s, plan);
        const { sql, params } = compileModify(s, plan, changes);
        return adapter.run(sql, params).changes;
      };
      return hasMulti(s) ? inTransaction(run) : run();
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
      return inTransaction(() =>
        ops.map(({ op, table, args }) => {
          const fn = (api as unknown as Record<string, unknown>)[op];
          if (typeof fn !== 'function' || op === 'batch' || op === 'migrate')
            throw new Error(`granth: "${op}" is not allowed in a transaction`);
          return (fn as (...a: unknown[]) => unknown)(table, ...args);
        })
      );
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
    size: () => E().size(),
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
