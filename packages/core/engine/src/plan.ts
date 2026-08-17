// Query plan (plain serializable data) -> SQL.
//
// The client builds plans, the worker compiles them. Nothing but data crosses
// the postMessage boundary — no SQL strings, no functions, no eval.
// Pure module: testable without SQLite or a browser.

import { findIndex, indexExpr, quoteIdent as q, shadowTable } from './schema.js';
import type { IndexDef, StoreDef } from './schema.js';
import { encodeParam, prefixUpperBound } from './codec.js';

/** A value that can be stored in an index. */
export type IndexableValue = string | number | boolean | null;

export interface Condition {
  index: string;
  op: string;
  values?: unknown[];
}

export interface QueryPlan {
  /** OR of ANDs. Empty means every row. */
  or: Array<{ and: Condition[] }>;
  order?: { index: string; desc?: boolean } | null;
  offset?: number;
  limit?: number | null;
  reverse?: boolean;
}

export type QueryMode = 'docs' | 'keys' | 'count' | 'indexKeys' | 'uniqueIndexKeys';

export interface CompiledSql {
  sql: string;
  params: unknown[];
}

type Fragment = { sql: string; params: unknown[] };

/**
 * Every parameter goes through the codec on the way to SQLite: booleans have no
 * SQLite type and cannot be bound at all, and Dates must match the encoded form
 * stored in the document.
 */
const P = (values: unknown[]): unknown[] => values.map(encodeParam);

/**
 * Match rows having ANY element satisfying the condition.
 *
 * An `IN (SELECT k FROM shadow WHERE v ...)` subquery, NOT a correlated EXISTS.
 * The correlated form makes SQLite walk the base table and probe once per row —
 * measured at 295 ms vs 2.4 ms for an ordinary index on 5k rows. This form seeks
 * the shadow table's (v, k) primary key first, then looks up by primary key.
 */
function multiEntryIn(store: StoreDef, ix: IndexDef, sqlCond: (expr: string) => string, params: unknown[]): Fragment {
  const s = shadowTable(store, ix);
  return {
    sql:
      `${q(store.table)}.${q(store.primKey.name)} IN ` +
      `(SELECT sx."k" FROM ${q(s)} sx WHERE ${sqlCond('sx."v"')})`,
    params,
  };
}

function compileCond(store: StoreDef, cond: Condition): Fragment {
  const ix = findIndex(store, cond.index);
  const vals = cond.values ?? [];

  // A multiEntry index is a set per row, so every operator becomes "some element matches".
  const build = (make: (expr: string) => Fragment): Fragment => {
    if (!ix.multi) {
      const { sql, params } = make(indexExpr(store, ix));
      return { sql, params };
    }
    const inner = make('sx."v"');
    return multiEntryIn(store, ix, () => inner.sql, inner.params);
  };

  switch (cond.op) {
    case 'equals':
      if (ix.compound) {
        return {
          sql: ix.keyPaths.map((_, i) => `${indexExpr(store, ix, i)} = ?`).join(' AND '),
          params: P(vals),
        };
      }
      return build((e) => ({ sql: `${e} = ?`, params: P([vals[0]]) }));
    case 'notEqual':
      return build((e) => ({ sql: `(${e} IS NULL OR ${e} <> ?)`, params: P([vals[0]]) }));
    case 'above':
      return build((e) => ({ sql: `${e} > ?`, params: P([vals[0]]) }));
    case 'aboveOrEqual':
      return build((e) => ({ sql: `${e} >= ?`, params: P([vals[0]]) }));
    case 'below':
      return build((e) => ({ sql: `${e} < ?`, params: P([vals[0]]) }));
    case 'belowOrEqual':
      return build((e) => ({ sql: `${e} <= ?`, params: P([vals[0]]) }));
    case 'between': {
      const [lo, hi, incLo = true, incHi = false] = vals;
      return build((e) => ({
        sql: `${e} >${incLo ? '=' : ''} ? AND ${e} <${incHi ? '=' : ''} ?`,
        params: P([lo, hi]),
      }));
    }
    case 'startsWith': {
      const hi = prefixUpperBound(vals[0]);
      if (hi === undefined) return build((e) => ({ sql: `${e} IS NOT NULL`, params: [] }));
      return build((e) => ({ sql: `${e} >= ? AND ${e} < ?`, params: P([vals[0], hi]) }));
    }
    case 'startsWithIgnoreCase':
      // ponytail: lower() defeats the index. Fine for small stores; add a lowercase
      // shadow index if this ever shows up in a profile.
      {
        const lo = String(vals[0]).toLowerCase();
        const hi = prefixUpperBound(lo);
        if (hi === undefined) return build((e) => ({ sql: `${e} IS NOT NULL`, params: [] }));
        return build((e) => ({ sql: `lower(${e}) >= ? AND lower(${e}) < ?`, params: [lo, hi] }));
      }
    case 'equalsIgnoreCase':
      return build((e) => ({ sql: `lower(${e}) = ?`, params: [String(vals[0]).toLowerCase()] }));
    case 'anyOfIgnoreCase': {
      if (!vals.length) return { sql: '0', params: [] };
      const lowered = vals.map((v) => String(v).toLowerCase());
      const ph = lowered.map(() => '?').join(', ');
      return build((e) => ({ sql: `lower(${e}) IN (${ph})`, params: lowered }));
    }
    case 'startsWithAnyOf':
    case 'startsWithAnyOfIgnoreCase': {
      if (!vals.length) return { sql: '0', params: [] };
      const ci = cond.op === 'startsWithAnyOfIgnoreCase';
      const params: unknown[] = [];
      const parts = vals.map((v) => {
        const p = ci ? String(v).toLowerCase() : v;
        params.push(encodeParam(p), prefixUpperBound(p) ?? String(p));
        return null;
      });
      return build((e) => {
        const col = ci ? `lower(${e})` : e;
        return { sql: parts.map(() => `(${col} >= ? AND ${col} < ?)`).join(' OR '), params };
      });
    }
    case 'anyOf': {
      if (!vals.length) return { sql: '0', params: [] }; // match nothing, not everything
      const ph = vals.map(() => '?').join(', ');
      return build((e) => ({ sql: `${e} IN (${ph})`, params: vals }));
    }
    case 'noneOf': {
      if (!vals.length) return { sql: '1', params: [] };
      const ph = vals.map(() => '?').join(', ');
      return build((e) => ({ sql: `(${e} IS NULL OR ${e} NOT IN (${ph}))`, params: vals }));
    }
    case 'isNull':
      return build((e) => ({ sql: `${e} IS NULL`, params: [] }));
    case 'notNull':
      return build((e) => ({ sql: `${e} IS NOT NULL`, params: [] }));
    default:
      throw new Error(`granth: unknown operator "${cond.op}"`);
  }
}

/** OR of ANDs -> a WHERE fragment. No conditions means every row. */
export function compileWhere(store: StoreDef, or: QueryPlan['or'] | undefined): Fragment {
  if (!or?.length) return { sql: '', params: [] };
  const params: unknown[] = [];
  const groups = or.map((group) => {
    const parts = group.and.map((c) => {
      const { sql, params: p } = compileCond(store, c);
      params.push(...p);
      return `(${sql})`;
    });
    return `(${parts.join(' AND ')})`;
  });
  return { sql: ` WHERE ${groups.join(' OR ')}`, params };
}

function compileOrderLimit(store: StoreDef, plan: QueryPlan): string {
  let sql = '';
  const pk = q(store.primKey.name);
  if (plan.order) {
    const ix = findIndex(store, plan.order.index);
    if (ix.multi) throw new Error(`granth: cannot order by multiEntry index "${ix.name}"`);
    const dir = plan.order.desc ? 'DESC' : 'ASC';
    const cols = ix.keyPaths.map((_, i) => `${indexExpr(store, ix, i)} ${dir}`);
    // Tiebreak on the primary key so paging is stable across calls.
    sql += ` ORDER BY ${cols.join(', ')}, ${pk} ${dir}`;
  } else if (plan.reverse) {
    sql += ` ORDER BY ${pk} DESC`;
  }
  if (plan.limit != null || plan.offset) {
    sql += ` LIMIT ${plan.limit == null ? -1 : Number(plan.limit)}`;
    if (plan.offset) sql += ` OFFSET ${Number(plan.offset)}`;
  }
  return sql;
}

/**
 * Which index a collection is "bound to", the way Dexie means it: the ORDER BY
 * index if there is one, else the first filtered index, else the primary key.
 * That is what keys()/uniqueKeys()/firstKey() report.
 */
export function boundIndex(store: StoreDef, plan: QueryPlan): string {
  return plan.order?.index ?? plan.or?.[0]?.and?.[0]?.index ?? store.primKey.name;
}

/**
 * @param {'docs'|'keys'|'count'|'indexKeys'|'uniqueIndexKeys'} mode
 * @returns {{sql: string, params: any[]}}
 */
export function compile(store: StoreDef, plan: QueryPlan, mode: QueryMode = 'docs'): CompiledSql {
  const t = q(store.table);
  const pk = q(store.primKey.name);
  const where = compileWhere(store, plan.or);

  if (mode === 'count') {
    // COUNT ignores limit/offset in Dexie unless explicitly limited; honour limit if set.
    if (plan.limit == null && !plan.offset) {
      return { sql: `SELECT COUNT(*) AS n FROM ${t}${where.sql}`, params: where.params };
    }
    const inner = `SELECT ${pk} FROM ${t}${where.sql}${compileOrderLimit(store, plan)}`;
    return { sql: `SELECT COUNT(*) AS n FROM (${inner})`, params: where.params };
  }

  if (mode === 'indexKeys' || mode === 'uniqueIndexKeys') {
    const ix = findIndex(store, boundIndex(store, plan));
    const distinct = mode === 'uniqueIndexKeys' ? 'DISTINCT ' : '';
    if (ix.multi) {
      // Element keys live in the shadow table, so read them from there rather
      // than from a column that does not exist on the base row.
      const inner = compile(store, plan, 'keys');
      const s = q(shadowTable(store, ix));
      return {
        sql: `SELECT ${distinct}sx."v" AS "k" FROM ${s} sx WHERE sx."k" IN (${inner.sql}) ORDER BY sx."v"`,
        params: inner.params,
      };
    }
    const expr = ix.compound
      ? `json_array(${ix.keyPaths.map((_, i) => indexExpr(store, ix, i)).join(', ')})`
      : indexExpr(store, ix);
    return {
      sql: `SELECT ${distinct}${expr} AS "k" FROM ${t}${where.sql}${compileOrderLimit(store, plan)}`,
      params: where.params,
    };
  }

  const select = mode === 'keys' ? pk : `${pk}, "_doc"`;
  return {
    sql: `SELECT ${select} FROM ${t}${where.sql}${compileOrderLimit(store, plan)}`,
    params: where.params,
  };
}

/** DELETE matching a plan. Uses a subquery so ORDER/LIMIT work everywhere. */
export function compileDelete(store: StoreDef, plan: QueryPlan): CompiledSql {
  const t = q(store.table);
  const pk = q(store.primKey.name);
  const inner = compile(store, plan, 'keys');
  return { sql: `DELETE FROM ${t} WHERE ${pk} IN (${inner.sql})`, params: inner.params };
}

/** Merge-patch every matching doc (RFC 7396 via SQLite json_patch). */
export function compileModify(store: StoreDef, plan: QueryPlan, changes: object): CompiledSql {
  const t = q(store.table);
  const pk = q(store.primKey.name);
  const inner = compile(store, plan, 'keys');
  return {
    sql: `UPDATE ${t} SET "_doc" = json_patch("_doc", ?) WHERE ${pk} IN (${inner.sql})`,
    params: [JSON.stringify(changes), ...inner.params],
  };
}
