// Query plan (plain serializable data) -> SQL.
//
// The client builds plans, the worker compiles them. Nothing but data crosses
// the postMessage boundary — no SQL strings, no functions, no eval.
// Pure module: testable without SQLite or a browser.

import { findIndex, indexExpr, quoteIdent as q, shadowTable } from './schema.js';
import type { IndexDef, StoreDef } from './schema.js';
import { encodeParam, prefixUpperBound, encodePatch, expandPaths, NON_KEY_SENTINELS, NULL_SENTINEL } from './codec.js';

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

const SENT_PH = NON_KEY_SENTINELS.map(() => '?').join(', ');

/**
 * The Unicode-aware case-folding function the engine registers.
 *
 * Emitted unconditionally. An adapter without createFunction fails LOUDLY here
 * ("no such function"), and only on an ignore-case query — which is far better
 * than SQLite's ASCII-only lower() quietly returning too few rows.
 */
export const LOWER = 'granth_lower';

/**
 * A range predicate, with null/undefined excluded.
 *
 * SQLite orders INTEGER before TEXT, and null/undefined are stored as TEXT
 * sentinels — so `age > 18` matched every row whose age was null or absent.
 * IndexedDB keeps such records out of the index entirely; this is the
 * equivalent. Only RANGE operators need it: `equals` compares against an
 * encoded value, so it can never accidentally match a sentinel.
 */
const range = (expr: string, sql: string, params: unknown[]): Fragment => ({
  sql: `(${sql}) AND ${expr} NOT IN (${SENT_PH})`,
  params: [...params, ...NON_KEY_SENTINELS],
});

/**
 * "This row HAS a key in this index" — index membership, over the store columns.
 *
 * The same rule `range()` enforces, but stated positively and usable where there
 * is no comparison to hang it off: notEqual, noneOf, startsWith(''), and ORDER
 * BY. Those four emitted no membership predicate at all, so a soft-delete query
 * (`where('deletedAt').notEqual(x)`) returned every row that had never been
 * deleted, and orderBy('name') listed rows with no name.
 *
 * All components for a compound index: IndexedDB omits a record from a compound
 * index when ANY component is absent, not just the first.
 */
function presence(store: StoreDef, ix: IndexDef): Fragment {
  // multiEntry membership is the shadow table's job — a row is in the index iff
  // it has a shadow entry, which the IN (SELECT ...) already decides.
  if (ix.multi) return { sql: '1', params: [] };
  return {
    sql: ix.keyPaths
      .map((_, i) => {
        const e = indexExpr(store, ix, i);
        return `(${e} IS NOT NULL AND ${e} NOT IN (${SENT_PH}))`;
      })
      .join(' AND '),
    params: ix.keyPaths.flatMap(() => [...NON_KEY_SENTINELS]),
  };
}

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


/**
 * Range comparison on a COMPOUND index, as a lexicographic tuple compare.
 *
 * The old code called indexExpr with the default component and bound vals[0] —
 * the tuple's tail was simply discarded, so `.above([1, 3])` compiled to
 * `a > 1` and both under- and over-matched depending on the operator, while
 * `.between` threw "Unknown named parameter". Silent wrong answers in the same
 * operator family.
 *
 * The correct expansion for (a, b) > (x, y) is
 *   a > x OR (a = x AND b > y)
 * generalised to n components, with the final comparison inclusive when the
 * operator is.
 *
 * Returns undefined for non-compound indexes so the caller keeps its simple path.
 */
function compoundRange(
  store: StoreDef,
  ix: IndexDef,
  vals: unknown[],
  op: '>' | '>=' | '<' | '<='
): Fragment | undefined {
  if (!ix.compound) return undefined;
  // Accept both .above([a, b]) and .above(a, b): the client unwraps a single
  // array argument for equals, and the two shapes reaching here differently is
  // exactly the kind of asymmetry that produced the original bug.
  const tuple = vals.length === 1 && Array.isArray(vals[0]) ? (vals[0] as unknown[]) : vals;
  if (!tuple.length) return undefined;

  // A PARTIAL tuple is not a scalar compare. IndexedDB array-key ordering puts a
  // prefix BEFORE any longer array starting with it ([1] < [1,'x']), so treating
  // .above([1]) as `a > 1` silently drops every a=1 row while .belowOrEqual([1])
  // silently includes them. Two of the four operators happened to come out right,
  // which is what makes it hard to notice. Refuse rather than guess.
  if (tuple.length !== ix.keyPaths.length) {
    throw new Error(
      `granth: "${ix.name}" has ${ix.keyPaths.length} components, but ${tuple.length} ` +
        `${tuple.length === 1 ? 'was' : 'were'} given. A range on a compound index needs the ` +
        `whole tuple — a partial one does not mean what array-key ordering says it means.`
    );
  }

  const strict = op === '>' || op === '<';
  const dir = op.startsWith('>') ? '>' : '<';
  const parts: string[] = [];
  const params: unknown[] = [];

  for (let i = 0; i < tuple.length; i++) {
    const eqs: string[] = [];
    for (let j = 0; j < i; j++) {
      eqs.push(`${indexExpr(store, ix, j)} = ?`);
      params.push(encodeParam(tuple[j]));
    }
    const last = i === tuple.length - 1;
    const cmp = last && !strict ? `${dir}=` : dir;
    eqs.push(`${indexExpr(store, ix, i)} ${cmp} ?`);
    params.push(encodeParam(tuple[i]));
    parts.push(`(${eqs.join(' AND ')})`);
  }

  // The SAME sentinel exclusion every other range operator gets. Returning this
  // fragment raw reintroduced, on compound indexes only, the exact bug `range()`
  // was written to fix: rows whose key is null or absent leaking into an
  // open-ended range. Applied to the FIRST component, which is what any
  // lexicographic comparison keys off.
  const first = indexExpr(store, ix, 0);
  return {
    sql: `(${parts.join(' OR ')}) AND ${first} NOT IN (${NON_KEY_SENTINELS.map(() => '?').join(', ')})`,
    params: [...params, ...NON_KEY_SENTINELS],
  };
}

/**
 * One condition as SQL over `e`, the expression naming the key.
 *
 * `e` is the generated column for an ordinary index and `sx."v"` for a
 * multiEntry element. Splitting this out of compileCond is what lets the
 * key ACCESSORS (keys/uniqueKeys/eachKey) reuse the element predicate: they used
 * to select every element of every matching row, so
 * `where('tags').equals('a').uniqueKeys()` answered ['a','b'].
 *
 * Compound indexes are never multiEntry, so the compound branches address their
 * own columns and ignore `e`.
 */
function condSql(store: StoreDef, ix: IndexDef, cond: Condition, e: string): Fragment {
  const vals = cond.values ?? [];
  const build = (make: (expr: string) => Fragment): Fragment => make(e);

  switch (cond.op) {
    case 'equals':
      if (ix.compound) {
        return {
          sql: ix.keyPaths.map((_, i) => `${indexExpr(store, ix, i)} = ?`).join(' AND '),
          params: P(vals),
        };
      }
      return build((e) => ({ sql: `${e} = ?`, params: P([vals[0]]) }));
    case 'notEqual': {
      // "Not equal" still means "has a key in this index". `IS NULL OR` did the
      // exact opposite: it PULLED IN every row whose key was absent.
      if (ix.compound) {
        const tuple = vals.length === 1 && Array.isArray(vals[0]) ? (vals[0] as unknown[]) : vals;
        const eq = ix.keyPaths.map((_, i) => `${indexExpr(store, ix, i)} = ?`).join(' AND ');
        const pres = presence(store, ix);
        return { sql: `NOT (${eq}) AND ${pres.sql}`, params: [...P(tuple), ...pres.params] };
      }
      return build((e2) => range(e2, `${e2} <> ?`, P([vals[0]])));
    }
    case 'above':
      return compoundRange(store, ix, vals, '>') ?? build((e) => range(e, `${e} > ?`, P([vals[0]])));
    case 'aboveOrEqual':
      return compoundRange(store, ix, vals, '>=') ?? build((e) => range(e, `${e} >= ?`, P([vals[0]])));
    case 'below':
      return compoundRange(store, ix, vals, '<') ?? build((e) => range(e, `${e} < ?`, P([vals[0]])));
    case 'belowOrEqual':
      return compoundRange(store, ix, vals, '<=') ?? build((e) => range(e, `${e} <= ?`, P([vals[0]])));
    case 'between': {
      const [lo, hi, incLo = true, incHi = false] = vals;
      // between never routed through compoundRange, so on a compound index it
      // fell to the scalar path and bound the tuple ARRAY as a parameter —
      // "Unknown named parameter". The docblock claimed this was fixed; it was
      // fixed for above/below only. A between is just the two bounds ANDed.
      if (ix.compound) {
        const lower = compoundRange(store, ix, [lo], incLo ? '>=' : '>');
        const upper = compoundRange(store, ix, [hi], incHi ? '<=' : '<');
        if (lower && upper) {
          return { sql: `(${lower.sql}) AND (${upper.sql})`, params: [...lower.params, ...upper.params] };
        }
      }
      return build((e) =>
        range(e, `${e} >${incLo ? '=' : ''} ? AND ${e} <${incHi ? '=' : ''} ?`, P([lo, hi]))
      );
    }
    case 'startsWith': {
      const hi = prefixUpperBound(vals[0]);
      // startsWith('') is "every key in the index", NOT "every row" — a row with
      // no key is not in the index at all.
      if (hi === undefined) return build((e2) => range(e2, `${e2} IS NOT NULL`, []));
      return build((e2) => range(e2, `${e2} >= ? AND ${e2} < ?`, P([vals[0], hi])));
    }
    case 'startsWithIgnoreCase':
      // ponytail: lower() defeats the index. Fine for small stores; add a lowercase
      // shadow index if this ever shows up in a profile.
      {
        const lo = String(vals[0]).toLowerCase();
        const hi = prefixUpperBound(lo);
        if (hi === undefined) return build((e) => ({ sql: `${e} IS NOT NULL`, params: [] }));
        return build((e) => ({ sql: `${LOWER}(${e}) >= ? AND ${LOWER}(${e}) < ?`, params: [lo, hi] }));
      }
    case 'equalsIgnoreCase':
      return build((e) => ({ sql: `${LOWER}(${e}) = ?`, params: [String(vals[0]).toLowerCase()] }));
    case 'anyOfIgnoreCase': {
      if (!vals.length) return { sql: '0', params: [] };
      const lowered = vals.map((v) => String(v).toLowerCase());
      const ph = lowered.map(() => '?').join(', ');
      return build((e) => ({ sql: `${LOWER}(${e}) IN (${ph})`, params: lowered }));
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
        const col = ci ? `${LOWER}(${e})` : e;
        return { sql: parts.map(() => `(${col} >= ? AND ${col} < ?)`).join(' OR '), params };
      });
    }
    // P() here for the same reason as everywhere else: a raw Date is not
    // bindable and a raw boolean cannot be bound at all. Without it,
    // anyOf([date]) returned nothing and anyOf([true]) threw, while the
    // equivalent equals() worked — the asymmetry made it look like bad data.
    case 'anyOf': {
      if (!vals.length) return { sql: '0', params: [] }; // match nothing, not everything
      const ph = vals.map(() => '?').join(', ');
      return build((e) => ({ sql: `${e} IN (${ph})`, params: P(vals) }));
    }
    case 'noneOf': {
      // noneOf([]) excludes nothing, but it is still an index scan: rows with no
      // key are not in the index. It returned literally every row.
      if (!vals.length) return build((e2) => range(e2, `${e2} IS NOT NULL`, []));
      const ph = vals.map(() => '?').join(', ');
      return build((e2) => range(e2, `${e2} NOT IN (${ph})`, P(vals)));
    }
    // A STORED null is the NULL sentinel, not SQL NULL — SQL NULL means the key
    // is absent from the document. isNull() tested only the latter, so it
    // reported the opposite of equals(null) on the very same row.
    case 'isNull':
      return build((e) => ({ sql: `(${e} IS NULL OR ${e} = ?)`, params: [NULL_SENTINEL] }));
    case 'notNull':
      // BOTH non-key sentinels. Excluding only null left `undefined` counted as
      // a real value, so notNull disagreed with the range path on the same row —
      // this file's own doctrine is that neither is a valid index key.
      return build((e) => ({
        sql: `(${e} IS NOT NULL AND ${e} NOT IN (${NON_KEY_SENTINELS.map(() => '?').join(', ')}))`,
        params: [...NON_KEY_SENTINELS],
      }));
    default:
      throw new Error(`granth: unknown operator "${cond.op}"`);
  }
}

/** A multiEntry index is a set per row, so every operator becomes "some element matches". */
function compileCond(store: StoreDef, cond: Condition): Fragment {
  const ix = findIndex(store, cond.index);
  if (!ix.multi) return condSql(store, ix, cond, indexExpr(store, ix));
  const inner = condSql(store, ix, cond, 'sx."v"');
  return multiEntryIn(store, ix, () => inner.sql, inner.params);
}

/**
 * The element-level predicate for a multiEntry index, over `sx."v"`.
 *
 * Used only by the key accessors. Without it they read every element of every
 * matching row rather than the elements that matched, so a tag facet count
 * listed tags the filter had excluded. count() and primaryKeys() on the same
 * collection were right, which is what made it look like bad data.
 */
function elementCond(store: StoreDef, ix: IndexDef, plan: QueryPlan): Fragment {
  const groups = (plan.or ?? []).map((g) => g.and.filter((c) => c.index === ix.name));
  // No group, or any group placing no constraint on this index, means every
  // element of a matching row is genuinely visited.
  if (!groups.length || groups.some((g) => !g.length)) return { sql: '1', params: [] };
  const params: unknown[] = [];
  const sql = groups
    .map((g) => g.map((c) => {
      const f = condSql(store, ix, c, 'sx."v"');
      params.push(...f.params);
      return `(${f.sql})`;
    }).join(' AND '))
    .map((s) => `(${s})`)
    .join(' OR ');
  return { sql, params };
}

/**
 * OR of ANDs -> a WHERE fragment. No conditions means every row.
 *
 * `extra` is ANDed after the groups — it carries the index-membership predicate
 * for an explicit ORDER BY, which has nowhere else to live.
 */
export function compileWhere(store: StoreDef, or: QueryPlan['or'] | undefined, extra?: Fragment): Fragment {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (or?.length) {
    const groups = or.map((group) => {
      const inner = group.and.map((c) => {
        const { sql, params: p } = compileCond(store, c);
        params.push(...p);
        return `(${sql})`;
      });
      return `(${inner.join(' AND ')})`;
    });
    parts.push(groups.join(' OR '));
  }
  if (extra && extra.sql !== '1') {
    parts.push(`(${extra.sql})`);
    params.push(...extra.params);
  }
  if (!parts.length) return { sql: '', params: [] };
  // Only bracket when there is something to bracket AGAINST — a lone group is
  // already parenthesised, and the extra layer is pure noise in every assertion.
  return { sql: ` WHERE ${parts.length === 1 ? parts[0] : parts.map((p) => `(${p})`).join(' AND ')}`, params };
}

/**
 * ORDER BY the BOUND index, always — and make reverse() flip that, not the
 * primary key.
 *
 * Emitting no ORDER BY left the order up to whichever index SQLite decided was
 * cheapest, so `where('age').above(15)` came back in age order by accident and
 * adding an unrelated index could silently reorder a user's list. Dexie always
 * iterates the bound index, and `.offset().limit()` over a wrong order returns
 * DIFFERENT ROWS, not merely a different arrangement — paging was the sharp edge.
 */
function compileOrderLimit(store: StoreDef, plan: QueryPlan): string {
  const pk = q(store.primKey.name);
  if (plan.order && findIndex(store, plan.order.index).multi) {
    throw new Error(`granth: cannot order by multiEntry index "${plan.order.index}"`);
  }
  const ix = findIndex(store, plan.order?.index ?? boundIndex(store, plan));
  // reverse() folds into order.desc on the client when an order is set, so only
  // one of the two is ever meaningful.
  const dir = (plan.order ? plan.order.desc : plan.reverse) ? 'DESC' : 'ASC';
  // A multiEntry key lives in the shadow table, not in a column here; its rows
  // all share the matched element anyway, so the primary key is the real order.
  const cols = ix.multi || ix.isPrimary ? [] : ix.keyPaths.map((_, i) => `${indexExpr(store, ix, i)} ${dir}`);
  // Tiebreak on the primary key so paging is stable across calls.
  let sql = ` ORDER BY ${[...cols, `${pk} ${dir}`].join(', ')}`;

  if (plan.limit != null || plan.offset) {
    // Number() straight into the SQL text meant limit(-1) returned EVERY row
    // (SQLite reads a negative limit as unlimited) where Dexie returns none — so
    // a `limit(pageSize - taken)` that underflowed dumped the whole table — and
    // limit(1.7)/limit(NaN) were SQL errors. Clamp to a non-negative integer.
    sql += ` LIMIT ${plan.limit == null ? -1 : Math.max(0, Math.floor(Number(plan.limit) || 0))}`;
    if (plan.offset) sql += ` OFFSET ${Math.max(0, Math.floor(Number(plan.offset) || 0))}`;
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
  // orderBy('name') iterates the NAME index, so a row with no name is not in the
  // result at all. Only an EXPLICIT order needs this: an implicit bound index
  // comes from a filter, which already constrains the key, or is the primary key.
  const where = compileWhere(
    store,
    plan.or,
    plan.order ? presence(store, findIndex(store, plan.order.index)) : undefined
  );

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
      // ...and only the elements the condition MATCHED. Filtering by primary key
      // alone returned every tag of every matching row.
      const el = elementCond(store, ix, plan);
      return {
        sql:
          `SELECT ${distinct}sx."v" AS "k" FROM ${s} sx ` +
          `WHERE sx."k" IN (${inner.sql}) AND (${el.sql}) ORDER BY sx."v"`,
        params: [...inner.params, ...el.params],
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
    // encode + expandPaths, exactly as engine.update() does. Without encode a
    // modify({x: null}) DELETED the key instead of setting null, a Date came
    // back as a string, and NaN vanished — while the same change through
    // table.update() behaved correctly. Two paths, two semantics, no warning.
    params: [JSON.stringify(encodePatch(expandPaths(changes as Record<string, unknown>))), ...inner.params],
  };
}
