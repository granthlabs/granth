// Granth — a Dexie-shaped API over SQLite/OPFS, running in one worker,
// coordinated across tabs by opfs-leader.
//
// Client side: builds serializable query plans and RPCs them. No SQL here.
// Behaviour is matched against the real `dexie` package by compat-audit.mjs.

import { workerRuntime } from 'granth-runtime-worker';
import type {
  LitiePlugin as GranthPlugin,
  OperationContext,
  OperationName,
  PluginContext,
  PluginHandle,
  RuntimeConnection,
  RuntimePlugin,
  StoragePlugin,
} from 'granth-protocol';

/**
 * Errors are flattened to {message,name} crossing postMessage, so the class is
 * lost on the worker runtime while it survives on the inline one. Rehydrating by
 * name here makes `instanceof` behave identically on both — otherwise the same
 * catch block would work in tests and fail in production.
 */
export class VersionError extends Error {
  constructor(message) { super(message); this.name = 'VersionError'; }
}

const ERRORS = { VersionError };

function reviveError(err) {
  const Ctor = ERRORS[err?.name];
  if (!Ctor || err instanceof Ctor) return err;
  const out = new Ctor(err.message);
  if (err.stack) out.stack = err.stack;
  return out;
}

const remove = (arr, item) => { const i = arr.indexOf(item); if (i >= 0) arr.splice(i, 1); };

const clone = (p) => ({ ...p, or: p.or.map((g) => ({ and: [...g.and] })) });
const emptyPlan = () => ({ or: [], order: null, offset: 0, limit: null, reverse: false });

/** Read a possibly-dotted keyPath, the way Dexie's getByKeyPath does. */
export function getByKeyPath(obj, keyPath) {
  if (obj == null) return undefined;
  if (!keyPath.includes('.')) return obj[keyPath];
  return keyPath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/**
 * A liveQuery dedupe key that distinguishes Maps and Sets.
 *
 * `JSON.stringify(new Map(...))` is '{}' for EVERY map — including the one
 * toMap() returns — so the second emission always compared equal to the first
 * and the subscriber never heard again. No error, just a UI that quietly stopped
 * updating. Two documented features, combined, produced silence.
 */
const dedupeKey = (v) =>
  JSON.stringify(v, (_k, x) =>
    x instanceof Map ? { '@m': [...x] } : x instanceof Set ? { '@s': [...x] } : x
  );

/**
 * Retry a call that provably never ran.
 *
 * `NoLeaderError` means no tab took ownership, so nothing executed — and that is
 * now enforced rather than merely believed: a leader fences any call whose caller
 * has already given up, so a frozen tab cannot thaw and run it late. Retrying
 * automatically before that fence existed would have converted an occasional
 * hiccup into a systematic double-write, which is why this was left as a note on
 * the concurrency suite ("open() is idempotent, so the library could retry it
 * itself") instead of being done.
 *
 * `LeaderLostError` is deliberately NOT retried: the leader acknowledged the call
 * and then died, so the commit state is unknowable. Retrying it silently is
 * precisely the corruption the two error types exist to keep apart.
 *
 * Bounded, because a genuinely leaderless database — every tab closing — must
 * surface rather than spin. The delay matters: a NoLeaderError also makes the
 * client forget the leader it believed in, so the next attempt waits for a real
 * election instead of broadcasting into a gap where nobody is listening.
 */
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 60;

async function retryWhenNothingRan(run, { idempotent = false } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      // Matched by NAME, not instanceof: an error crossing postMessage is
      // flattened to {message, name} and loses its prototype, so the worker
      // runtime would never satisfy instanceof while the inline one would.
      const name = (err as Error | undefined)?.name;
      // `idempotent` widens this to LeaderLostError — "it may or may not have
      // committed" stops mattering when running it twice is indistinguishable
      // from running it once. Only open() claims that, and it earns it: migrate()
      // is gated on PRAGMA user_version and applies its DDL in one transaction,
      // so it either happened or did not, and repeating it is a no-op.
      const retryable = name === 'NoLeaderError' || (idempotent && name === 'LeaderLostError');
      if (!retryable || attempt >= RETRY_ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
    }
  }
}

/** Dexie's bulk return contract: the last key, or all of them with {allKeys: true}. */
const pickKeys = (keys, options) =>
  options?.allKeys ? keys : keys[keys.length - 1];

/** The keyPaths an index name covers: 'age' -> ['age'], '[name+age]' -> ['name','age']. */
const indexPaths = (name) =>
  name.startsWith('[') ? name.slice(1, -1).split('+') : [name];

function defaultCompare(a, b) {
  if (a === b) return 0;
  if (a === undefined) return 1; // undefined sorts last, as in Dexie
  if (b === undefined) return -1;
  return a < b ? -1 : 1;
}

// ---------------------------------------------------------------- Collection

class Collection {
  _table: string;
  _plan: any;
  _ctx: any;
  _filters: Array<(doc: any) => boolean>;
  _until: { fn: (doc: any) => boolean; includeStopEntry: boolean } | null;
  [op: string]: any;

  constructor(table, plan, ctx) {
    this._table = table;
    this._plan = plan;
    this._ctx = ctx;
    this._filters = [];
    this._until = null;
  }

  get db() { return this._ctx.db; }

  _next(mutate) {
    const c = new Collection(this._table, clone(this._plan), this._ctx);
    c._filters = [...this._filters];
    c._until = this._until;
    mutate(c._plan, c);
    return c;
  }

  /** Union: `.or('name').equals('x')` adds a second OR group. */
  or(index) {
    return new WhereClause(this._table, this._plan, this._ctx, index, this._filters, true);
  }

  /** JS predicate. Runs client-side after fetching — it cannot cross into the worker. */
  filter(fn) { return this._next((_, c) => c._filters.push(fn)); }
  and(fn) { return this.filter(fn); }

  limit(n) { return this._next((p) => (p.limit = n)); }
  offset(n) { return this._next((p) => (p.offset = n)); }
  reverse() {
    return this._next((p) => (p.order ? (p.order.desc = !p.order.desc) : (p.reverse = !p.reverse)));
  }
  /** Dexie's desc(): descending regardless of current direction. */
  desc() { return this._next((p) => (p.order ? (p.order.desc = true) : (p.reverse = true))); }

  /**
   * No-op, deliberately. Dexie needs distinct() because its multiEntry cursor
   * yields one hit per matching array element; our multiEntry compiles to an
   * `IN (SELECT ...)` subquery which already returns each row once. Kept so
   * migrated code runs unchanged.
   */
  distinct() { return this; }

  /** Stop iterating at the first doc matching `fn`. Client-side, like Dexie. */
  until(fn, includeStopEntry = false) {
    return this._next((_, c) => (c._until = { fn, includeStopEntry }));
  }

  /** Descending when the collection is reversed — plan.reverse, or order.desc once an order exists. */
  get _desc() { return Boolean(this._plan.order ? this._plan.order.desc : this._plan.reverse); }

  /**
   * Dexie returns a sorted ARRAY here, not a Collection — and sorts it entirely
   * client-side, whether or not the keyPath is indexed.
   *
   * Routing an indexed keyPath through ORDER BY instead looked like a free
   * optimisation and gave the same method two behaviours: it ignored reverse()
   * (so `t.reverse().sortBy('age')` came back exactly inverted, silently), and it
   * put rows with no key FIRST on an indexed path and LAST on a non-indexed one.
   */
  async sortBy(keyPath) {
    const dir = this._desc ? -1 : 1;
    const rows = await this.toArray();
    return rows.sort((a, b) => dir * defaultCompare(getByKeyPath(a, keyPath), getByKeyPath(b, keyPath)));
  }

  /** Not a Dexie member; kept as the chainable form of sortBy. */
  orderBy(index) { return this._next((p) => (p.order = { index, desc: false })); }

  _applyUntil(rows) {
    if (!this._until) return rows;
    const { fn, includeStopEntry } = this._until;
    const i = rows.findIndex(fn);
    if (i === -1) return rows;
    return rows.slice(0, includeStopEntry ? i + 1 : i);
  }

  get _clientSide() { return this._filters.length > 0 || this._until != null; }

  async toArray() {
    if (!this._clientSide) {
      return this._ctx.read(this._table, await this._ctx.call('query', this._table, this._plan, 'docs'));
    }
    // ponytail: JS filters/until force the limit/offset client-side, so the worker
    // returns every index match. Narrow with an indexed .where() first on large tables.
    const { limit, offset = 0, ...rest } = this._plan;
    let rows = this._ctx.read(
      this._table,
      await this._ctx.call('query', this._table, { ...rest, limit: null, offset: 0 }, 'docs')
    );
    for (const fn of this._filters) rows = rows.filter(fn);
    rows = this._applyUntil(rows);
    return rows.slice(offset, limit == null ? undefined : offset + limit);
  }

  async count() {
    if (this._clientSide) return (await this.toArray()).length;
    return this._ctx.call('query', this._table, this._plan, 'count');
  }

  /**
   * sum / avg / min / max over one field, computed in SQLite.
   *
   * Without these, the only way to total a column is `toArray()` and add up in
   * JS — which ships every matching row across postMessage to produce one
   * number. The Ledger showcase was moving ~14,000 rows per render to display
   * four totals: "it is all local" does not make structured-cloning 14,000
   * objects free, and the aggregation is exactly what the database was there to
   * do.
   *
   * A client-side `.filter()` forces the JS path, because the predicate cannot
   * cross into the worker — the same rule as everywhere else, degrading to
   * precisely what the caller would otherwise have written by hand.
   *
   * `sum` of no rows is null, not 0. SQL says so, and "nothing matched" is a
   * different fact from "it totalled zero" — which a ledger genuinely needs.
   */
  async sum(keyPath) { return this._agg('sum', keyPath); }
  async avg(keyPath) { return this._agg('avg', keyPath); }
  async min(keyPath) { return this._agg('min', keyPath); }
  async max(keyPath) { return this._agg('max', keyPath); }

  async _agg(fn, keyPath) {
    if (typeof keyPath !== 'string' || !keyPath) {
      throw new Error(`granth: ${fn}() needs a field name, e.g. ${fn}('amount')`);
    }
    if (this._clientSide) {
      const rows = await this.toArray();
      const vals = rows
        .map((r) => keyPath.split('.').reduce((o, k) => (o == null ? o : o[k]), r))
        .filter((v) => v != null && !Number.isNaN(Number(v)))
        .map(Number);
      if (!vals.length) return null;
      if (fn === 'sum') return vals.reduce((a, b) => a + b, 0);
      if (fn === 'avg') return vals.reduce((a, b) => a + b, 0) / vals.length;
      return fn === 'min' ? Math.min(...vals) : Math.max(...vals);
    }
    return this._ctx.call(
      'query',
      this._table,
      { ...this._plan, aggregate: { fn, field: keyPath } },
      'aggregate'
    );
  }

  async primaryKeys() {
    if (this._clientSide) return (await this.toArray()).map((d) => d[this._ctx.pk(this._table)]);
    return this._ctx.call('query', this._table, this._plan, 'keys');
  }

  /** Dexie's keys() are the INDEX keys, not the primary keys. */
  async keys() {
    if (this._clientSide) {
      // A compound index name is not a keyPath: reading '[name+age]' as a
      // property gave [undefined, ...], so attaching a .filter() silently
      // changed the answer the server-side branch returned.
      const paths = indexPaths(this._ctx.boundIndex(this._table, this._plan));
      const rows = await this.toArray();
      if (paths.length === 1) return rows.map((d) => getByKeyPath(d, paths[0]));
      return rows.map((d) => paths.map((p) => getByKeyPath(d, p)));
    }
    return this._ctx.call('query', this._table, this._plan, 'indexKeys');
  }

  async uniqueKeys() {
    if (this._clientSide) return [...new Set(await this.keys())];
    return this._ctx.call('query', this._table, this._plan, 'uniqueIndexKeys');
  }

  async firstKey() { return (await this.limit(1).keys())[0]; }
  async lastKey() { return (await this.reverse().limit(1).keys())[0]; }

  async first() { return (await this.limit(1).toArray())[0]; }
  async last() { return (await this.reverse().limit(1).toArray())[0]; }

  async each(fn) { (await this.toArray()).forEach((d) => fn(d)); }

  /**
   * Results keyed by primary key (or any keyPath) instead of an array — dexie#2009,
   * which today forces callers to fetch an array and reduce it by hand.
   */
  async toMap(keyPath) {
    const kp = keyPath ?? this._ctx.pk(this._table);
    return new Map((await this.toArray()).map((d) => [getByKeyPath(d, kp), d]));
  }

  /** `for await (const doc of collection)` — dexie#300. */
  async *[Symbol.asyncIterator]() {
    for (const doc of await this.toArray()) yield doc;
  }
  async eachKey(fn) { (await this.keys()).forEach((k) => fn(k)); }
  async eachUniqueKey(fn) { (await this.uniqueKeys()).forEach((k) => fn(k)); }
  async eachPrimaryKey(fn) { (await this.primaryKeys()).forEach((k) => fn(k)); }

  async delete() {
    if (this._clientSide || this._ctx.hasHook(this._table, 'deleting')) {
      const keys = await this.primaryKeys();
      return this._ctx.table(this._table).bulkDelete(keys).then((r) => r.length);
    }
    return this._ctx.write('deleteWhere', this._table, this._plan);
  }

  /**
   * Object form compiles to one `json_patch` UPDATE. Function form is Dexie's:
   * it reads the matching docs, applies `fn`, and writes them back in ONE atomic
   * batch — a JS function cannot cross into the worker.
   */
  async modify(changes) {
    if (typeof changes !== 'function') {
      if (this._clientSide || this._ctx.hasHook(this._table, 'updating')) {
        const keys = await this.primaryKeys();
        const t = this._ctx.table(this._table);
        for (const k of keys) await t.update(k, changes);
        return keys.length;
      }
      return this._ctx.write('modifyWhere', this._table, this._plan, changes);
    }

    const pk = this._ctx.pk(this._table);
    const docs = await this.toArray();
    const ops: Array<{ op: string; table: string; args: unknown[] }> = [];
    for (const doc of docs) {
      const ctx = { value: { ...doc } };
      fnApply(changes, ctx.value, ctx);
      if (ctx.value === undefined) ops.push({ op: 'delete', table: this._table, args: [doc[pk]] });
      else ops.push({ op: 'put', table: this._table, args: [{ ...ctx.value, [pk]: doc[pk] }] });
    }
    if (!ops.length) return 0;
    await this._ctx.writeBatch(ops, [this._table]);
    return ops.length;
  }
}

/** Dexie calls the modify function with `this` bound to a {value} context. */
function fnApply(fn, obj, ctx) {
  fn.call(ctx, obj, ctx);
}

// --------------------------------------------------------------- WhereClause

const OPS = [
  'equals', 'notEqual', 'above', 'aboveOrEqual', 'below', 'belowOrEqual',
  'startsWith', 'startsWithIgnoreCase', 'equalsIgnoreCase',
  'anyOf', 'anyOfIgnoreCase', 'noneOf', 'startsWithAnyOf', 'startsWithAnyOfIgnoreCase',
];

class WhereClause {
  _table: string;
  _plan: any;
  _ctx: any;
  _index: string;
  _filters: Array<(doc: any) => boolean>;
  _newGroup: boolean;
  // Operators are installed onto the prototype in a loop below, so the shape is
  // dynamic by construction.
  [op: string]: any;

  constructor(table, plan, ctx, index, filters: Array<(doc: any) => boolean> = [], newGroup = false) {
    this._table = table;
    this._plan = plan;
    this._ctx = ctx;
    this._index = index;
    this._filters = filters;
    this._newGroup = newGroup;
  }

  get db() { return this._ctx.db; }
  get Collection() { return Collection; }

  _add(op, values) {
    const plan = clone(this._plan);
    const cond = { index: this._index, op, values };
    if (this._newGroup || !plan.or.length) plan.or.push({ and: [cond] });
    else plan.or[plan.or.length - 1].and.push(cond);
    const c = new Collection(this._table, plan, this._ctx);
    c._filters = [...this._filters];
    return c;
  }

  between(lower, upper, includeLower = true, includeUpper = false) {
    return this._add('between', [lower, upper, includeLower, includeUpper]);
  }

  /** Each range becomes its own OR group. */
  inAnyRange(ranges) {
    if (!ranges?.length) return this._add('anyOf', []); // match nothing
    // slice(1): reducing over the full list would re-add range 0, which is already
    // the seed — harmless for results, but it doubles the SQL.
    return ranges
      .slice(1)
      .reduce((acc: any, [lo, hi]: any) => acc.or(this._index).between(lo, hi), this.between(...(ranges[0] as [any, any])));
  }

  isNull() { return this._add('isNull', []); }
  notNull() { return this._add('notNull', []); }
}

for (const op of OPS) {
  WhereClause.prototype[op] = function (...values) {
    // anyOf-style operators take a list; equals on a compound index takes the
    // tuple as an array. Both arrive as one array argument that must be spread
    // into params — binding the array itself throws in sqlite-wasm.
    // notEqual was excluded from the unwrap, so `notEqual(['a', 30])` on a
    // compound index bound the ARRAY as one parameter — "Unknown named
    // parameter" — while `equals(['a', 30])` on the same index worked.
    const flat = values.length === 1 && Array.isArray(values[0]) ? values[0] : values;
    return this._add(op, flat);
  };
}

// --------------------------------------------------------------------- Table

const HOOK_NAMES = ['creating', 'reading', 'updating', 'deleting'];

class Table {
  name: string;
  _ctx: any;
  _hooks: Record<string, Array<(...a: any[]) => any>>;
  _mapClass: (new (...a: any[]) => any) | null;
  [op: string]: any;

  constructor(name, ctx) {
    this.name = name;
    this._ctx = ctx;
    this._hooks = { creating: [], reading: [], updating: [], deleting: [] };
    this._mapClass = null;
  }

  get db() { return this._ctx.db; }
  get schema() { return this._ctx.schemaOf(this.name); }

  _all() { return new Collection(this.name, emptyPlan(), this._ctx); }

  where(indexOrCriteria) {
    if (typeof indexOrCriteria === 'string')
      return new WhereClause(this.name, emptyPlan(), this._ctx, indexOrCriteria);
    const plan: any = emptyPlan();
    plan.or.push({
      and: Object.entries(indexOrCriteria).map(([index, value]) => ({ index, op: 'equals', values: [value] })),
    });
    return new Collection(this.name, plan, this._ctx);
  }

  orderBy(index) { return this._all().orderBy(index); }
  filter(fn) { return this._all().filter(fn); }
  toArray() { return this._all().toArray(); }
  count() { return this._all().count(); }
  sum(keyPath) { return this._all().sum(keyPath); }
  avg(keyPath) { return this._all().avg(keyPath); }
  min(keyPath) { return this._all().min(keyPath); }
  max(keyPath) { return this._all().max(keyPath); }
  toCollection() { return this._all(); }
  each(fn) { return this._all().each(fn); }
  toMap(keyPath) { return this._all().toMap(keyPath); }
  limit(n) { return this._all().limit(n); }
  offset(n) { return this._all().offset(n); }
  reverse() { return this._all().reverse(); }
  [Symbol.asyncIterator]() { return this._all()[Symbol.asyncIterator](); }

  // -- hooks & mapping ------------------------------------------------------

  /**
   * Dexie-compatible hooks, run CLIENT-SIDE around the RPC.
   * Caveat vs Dexie: they are not inside the same SQLite statement as the write,
   * so a hook cannot veto a write that has already been committed.
   */
  hook(name, fn) {
    if (!HOOK_NAMES.includes(name)) throw new Error(`granth: unknown hook "${name}"`);
    if (typeof name === 'object') throw new TypeError('granth: hook(object) form is not supported');
    this._hooks[name].push(fn);
    return this;
  }
  /** @internal */ _has(name) { return this._hooks[name].length > 0; }

  mapToClass(Class) {
    this._mapClass = Class;
    return Class;
  }

  /** @internal applied to every document read out of the worker. */
  _read(docs) {
    const { reading } = this._hooks;
    if (!reading.length && !this._mapClass) return docs;
    return docs.map((doc) => {
      let d = doc;
      for (const fn of reading) d = fn(d) ?? d;
      if (this._mapClass) d = Object.assign(Object.create(this._mapClass.prototype), d);
      return d;
    });
  }

  _creating(doc) {
    if (!this._has('creating')) return doc;
    const copy = { ...doc };
    const pk = this._ctx.pk(this.name);
    for (const fn of this._hooks.creating) fn.call({}, copy[pk], copy);
    return copy;
  }

  // -- reads ----------------------------------------------------------------

  async get(key) {
    const doc = await this._ctx.call('get', this.name, key);
    return doc === undefined ? undefined : this._read([doc])[0];
  }
  async bulkGet(keys) {
    const docs = await this._ctx.call('bulkGet', this.name, keys);
    const present = this._read(docs.filter((d) => d !== undefined));
    let i = 0;
    return docs.map((d) => (d === undefined ? undefined : present[i++]));
  }

  // -- writes ---------------------------------------------------------------

  add(doc) { return this._ctx.write('add', this.name, this._creating(doc)); }
  put(doc) { return this._ctx.write('put', this.name, this._creating(doc)); }
  /**
   * Dexie returns the LAST key here, and every key only with {allKeys: true}.
   * Returning the array unconditionally meant `const id = await t.bulkAdd(xs)`
   * silently handed back an array where migrated code expected a number.
   */
  async bulkAdd(docs, options?) {
    return pickKeys(await this._ctx.write('bulkAdd', this.name, docs.map((d) => this._creating(d))), options);
  }
  async bulkPut(docs, options?) {
    return pickKeys(await this._ctx.write('bulkPut', this.name, docs.map((d) => this._creating(d))), options);
  }

  async update(key, changes) {
    let mods = changes;
    if (this._has('updating')) {
      const existing = await this._ctx.call('get', this.name, key);
      if (existing === undefined) return 0;
      for (const fn of this._hooks.updating) {
        const extra = fn.call({}, mods, key, existing);
        if (extra) mods = { ...mods, ...extra };
      }
    }
    return this._ctx.write('update', this.name, key, mods);
  }

  upsert(key, changes) { return this._ctx.write('upsert', this.name, key, changes); }
  bulkUpdate(ops) { return this._ctx.write('bulkUpdate', this.name, ops).then((r) => r.length); }

  async delete(key) {
    await this._fireDeleting([key]);
    return this._ctx.write('delete', this.name, key);
  }
  async bulkDelete(keys) {
    await this._fireDeleting(keys);
    return this._ctx.write('bulkDelete', this.name, keys);
  }
  async _fireDeleting(keys) {
    if (!this._has('deleting') || !keys.length) return;
    const docs = await this._ctx.call('bulkGet', this.name, keys);
    keys.forEach((k, i) => {
      if (docs[i] !== undefined) for (const fn of this._hooks.deleting) fn.call({}, k, docs[i]);
    });
  }

  clear() { return this._ctx.write('clear', this.name); }
}

/** Records writes inside the fast batch form of db.transaction(). */
class TxTable {
  name: string;
  _ops: Array<{ op: string; table: string; args: unknown[] }>;
  [op: string]: any;

  constructor(name, ops) { this.name = name; this._ops = ops; }
}
for (const op of ['add', 'put', 'bulkAdd', 'bulkPut', 'update', 'upsert', 'delete', 'bulkDelete', 'clear']) {
  TxTable.prototype[op] = function (...args) {
    this._ops.push({ op, table: this.name, args });
    return this;
  };
}

// -------------------------------------------------------------------- Granth

export class Granth {
  name: string;
  verno: number;
  // Tables are attached as properties (`db.friends`), which is the Dexie shape.
  [table: string]: any;

  constructor(
    name: string,
    {
      worker,
      timeoutMs,
      runtime,
      storage,
      ...rest
    }: {
      /** Shorthand for the default worker runtime. */
      worker?: () => Worker;
      timeoutMs?: number;
      /** Explicit runtime plugin. Overrides `worker`. */
      runtime?: RuntimePlugin;
      /** Storage plugins, tried in order. Consumed by the worker entry. */
      storage?: StoragePlugin[];
      [k: string]: unknown;
    } = {}
  ) {
    this.name = name;
    this.verno = 0;
    this._versions = [];
    this._tables = new Map();
    this._pk = new Map();
    this._idx = new Map();
    this._opened = null;
    this._listeners = new Set();
    this._events = { ready: [], versionchange: [], blocked: [], close: [] };
    this._isOpen = false;
    this._hasBeenClosed = false;
    this._hasFailed = false;
    this._inTx = false;
    this._runtimeOpt = runtime ?? null;
    this._storageOpt = storage ?? null;
    this._connectOpts = { worker, timeoutMs, ...rest };
    this._conn = null;
    this._plugins = new Map();
    this._storagePlugins = [];
    this._runtimeName = null;
    this._before = [];
    this._after = [];
    this._client = null;
    this._offRemote = null;
    this._offLeader = null;
    /** Serialises top-level transactions in THIS tab. See transaction(). */
    this._txChain = Promise.resolve();

    // liveQuery records which tables a querier touched so unrelated writes don't
    // re-run it. Concurrent subscriptions can over-record into each other's sets;
    // that only costs an extra re-run, never a missed one.
    this._tracking = null;

    const call = async (method, ...args) => {
      if (this._tracking && typeof args[0] === 'string') this._tracking.add(args[0]);
      // Auto-open, like Dexie. Without it, a query issued before open() resolves
      // hits a worker with no schema yet — the shape of Dexie #1273, where the
      // first toArray() returns [] and the second works.
      if (!this._opened) await this.open();
      return this._dispatch(method, args);
    };

    this._ctx = {
      db: this,
      call,
      pk: (table) => this._pk.get(table) ?? 'id',
      table: (t) => this.table(t),
      hasIndex: (table, kp) => this._idx.get(table)?.has(kp) ?? false,
      hasHook: (table, name) => this._tables.get(table)?._has(name) ?? false,
      read: (table, docs) => this._tables.get(table)?._read(docs) ?? docs,
      schemaOf: (table) => this._schemaOf(table),
      boundIndex: (table, plan) =>
        plan.order?.index ?? plan.or?.[0]?.and?.[0]?.index ?? (this._pk.get(table) ?? 'id'),
      write: async (method, table, ...args) => {
        const out = await call(method, table, ...args);
        this._emit([table], true);
        return out;
      },
      writeBatch: async (ops, tables) => {
        const out = await call('batch', null, ops);
        this._emit(tables ?? [...new Set(ops.map((o) => o.table))], true);
        return out;
      },
    };
  }

  /**
   * Browser APIs are touched here, NOT in the constructor, so `new Granth(...)` is
   * safe at module scope under SSR (Next.js, Nuxt, Angular Universal) where there
   * is no navigator.locks. Nothing happens until you actually use the database.
   */
  /**
   * Choose the runtime and connect. Nothing here runs in the constructor, so
   * `new Granth(...)` stays safe at module scope under SSR.
   *
   * The worker runtime is preferred because it is the only one that can use OPFS
   * (sync access handles are dedicated-worker-only) and the only one that keeps
   * SQL off the main thread. It falls back to inline rather than throwing, so a
   * strict CSP without `worker-src` degrades instead of breaking.
   */
  _ensure() {
    if (this._conn) return;
    const chosen = this._resolveRuntime();
    this._conn = chosen.connect({ name: this.name, timeoutMs: this._connectOpts.timeoutMs });
    this._runtimeName = chosen.name;
    this._offRemote = this._conn.onRemoteChange((tables) => this._emit(tables, false));

    // Schema lives in the LEADER's engine, not in the file. When leadership moves
    // to this tab, our worker has never run migrate(), so `_opened` — a cached
    // promise that was resolved against the OLD leader — has to be dropped or
    // every call fails with `no table "x". Declared: (none)` until a reload.
    // Two tabs is the case that shows it: the survivor elects ITSELF, and a
    // BroadcastChannel never delivers to its own sender.
    this._offLeader = this._conn.onLeadershipChange?.((isLeader) => {
      if (isLeader) this._opened = null;
    }) ?? null;
  }

  _resolveRuntime() {
    if (this._runtimeOpt) return this._runtimeOpt;
    if (this._connectOpts.worker) {
      const w = workerRuntime({
        worker: this._connectOpts.worker,
        ...(this._connectOpts.timeoutMs ? { timeoutMs: this._connectOpts.timeoutMs } : {}),
        ...(this._connectOpts.locks ? { locks: this._connectOpts.locks } : {}),
      });
      if (w.isAvailable()) return w;
    }
    throw new Error(
      'granth: no runtime available. Pass `worker: () => new Worker(...)` for the ' +
        'default worker runtime, or `runtime: inlineRuntime({ createHandlers })` to run ' +
        'without a Worker. `Granth.isSupported()` reports whether the worker runtime can run here.'
    );
  }

  /** True when this environment can actually run granth. Safe to call during SSR. */
  static isSupported() {
    return (
      typeof globalThis.Worker === 'function' &&
      typeof globalThis.BroadcastChannel === 'function' &&
      typeof globalThis.navigator?.locks?.request === 'function'
    );
  }

  /**
   * Serialize against interactive transactions. Ordinary calls take a SHARED
   * lock, `transaction()` takes an EXCLUSIVE one, so another tab's writes cannot
   * land inside somebody's open transaction. Skipped while we hold the exclusive
   * lock ourselves — re-requesting it would deadlock on the Web Locks queue.
   */
  /**
   * One funnel for every call: addon `before` hooks, the shared lock that keeps
   * ordinary writes out of somebody's open transaction, then `after` hooks.
   */
  async _dispatch(method, args) {
    this._ensure();
    const ctx = { op: method, table: typeof args[0] === 'string' ? args[0] : undefined, args };
    for (const fn of this._before) {
      const short = await fn(ctx);
      if (short !== undefined) return short;   // a hook answered; skip the round trip
    }
    const run = () => this._conn.call(method, ...ctx.args);
    const attempt = () =>
      // The retry wraps the LOCK too, not just the call: a NoLeaderError makes
      // the client forget its leader, so the next attempt has to re-acquire
      // through the same path rather than reuse a stale one.
      retryWhenNothingRan(() => (this._inTx ? run() : this._conn.withLock('shared', run)));

    let result;
    try {
      result = await attempt();
    } catch (err) {
      // "Declared: (none)" means the WORKER has no schema — it is a freshly
      // elected leader that has not run migrate() yet, not a bad query.
      //
      // Schema lives in the leader's engine, not in the file. The tab that wins
      // an election drops its own cached open() so its next call re-migrates,
      // but a FOLLOWER holding a resolved open() from the previous leader will
      // happily send a data call to the new one first, and arrive before it has
      // re-opened. Re-opening here closes that window; open() is idempotent, so
      // doing it again costs nothing. Once only, so a genuinely undeclared table
      // still fails loudly instead of looping.
      if (this._inTx || !/Declared: \(none\)/.test(String((err as Error | undefined)?.message ?? ''))) {
        throw reviveError(err);
      }
      this._opened = null;
      await this.open();
      try {
        result = await attempt();
      } catch (again) {
        throw reviveError(again);
      }
    }
    for (const fn of this._after) {
      const replaced = await fn(ctx, result);
      if (replaced !== undefined) result = replaced;
    }
    return result;
  }

  /**
   * Register an addon. Returns a handle so it can be removed again at runtime —
   * add, remove, expand.
   */
  use(plugin) {
    if (this._plugins.has(plugin.name)) {
      throw new Error(`granth: plugin "${plugin.name}" is already registered`);
    }
    const disposers: Array<() => unknown> = [];
    const context = {
      before: (fn) => { this._before.push(fn); disposers.push(() => remove(this._before, fn)); },
      after: (fn) => { this._after.push(fn); disposers.push(() => remove(this._after, fn)); },
      registerStorage: (p) => { this._storagePlugins.push(p); disposers.push(() => remove(this._storagePlugins, p)); },
      registerRuntime: (p) => { this._runtimeOpt = p; },
      onDispose: (fn) => disposers.push(fn),
    };
    const returned = plugin.setup(context);
    if (typeof returned === 'function') disposers.push(returned);
    const handle = {
      name: plugin.name,
      dispose: async () => {
        for (const d of disposers.reverse()) await d();
        this._plugins.delete(plugin.name);
      },
    };
    this._plugins.set(plugin.name, handle);
    return handle;
  }

  /** Registered addon names, in registration order. */
  get plugins() { return [...this._plugins.keys()]; }

  /** Which runtime actually connected: 'worker' or 'inline'. */
  runtimeKind() { this._ensure(); return this._runtimeName; }

  version(n) {
    const spec = { version: n, stores: {} };
    this._versions.push(spec);
    this.verno = Math.max(this.verno, n);
    return {
      stores: (stores) => {
        spec.stores = stores;
        for (const [table, def] of Object.entries(stores)) {
          if (def === null) { this._tables.delete(table); this._idx.delete(table); delete this[table]; continue; }
          const parts = String(def).split(',').map((s) => s.trim()).filter(Boolean);
          this._pk.set(table, parts[0].replace(/^\+\+|^&/, ''));
          this._idx.set(
            table,
            new Set([parts[0].replace(/^\+\+|^&/, ''), ...parts.slice(1).map((p) => p.replace(/^[&*]/, ''))])
          );
          if (!this._tables.has(table)) {
            const t = new Table(table, this._ctx);
            this._tables.set(table, t);
            if (!(table in this)) this[table] = t;
          }
        }
        return {
          upgrade: () => {
            throw new Error(
              'granth: upgrade() functions cannot cross into the worker — ' +
                'register them in your worker file as startGranthWorker({ upgrades: { 2: fn } })'
            );
          },
        };
      },
    };
  }

  table(name) {
    const t = this._tables.get(name);
    if (!t) throw new Error(`granth: no table "${name}"`);
    return t;
  }
  get tables() { return [...this._tables.values()]; }

  _schemaOf(name) {
    const parts = String(this._versions.findLast((v) => v.stores[name])?.stores[name] ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const pk = parts[0] ?? 'id';
    return {
      name,
      primKey: {
        name: pk.replace(/^\+\+|^&/, ''),
        keyPath: pk.replace(/^\+\+|^&/, ''),
        auto: pk.startsWith('++'),
        unique: true, multi: false, compound: false, src: pk,
      },
      indexes: parts.slice(1).map((src) => {
        const name = src.replace(/^[&*]/, '');
        return {
          name, keyPath: name.startsWith('[') ? name.slice(1, -1).split('+') : name,
          unique: src.startsWith('&'), multi: src.includes('*'),
          compound: name.startsWith('['), auto: false, src,
        };
      }),
    };
  }

  isOpen() { return this._isOpen; }
  hasBeenClosed() { return this._hasBeenClosed; }
  hasFailed() { return this._hasFailed; }

  on(event, fn) {
    if (!(event in this._events)) throw new Error(`granth: unknown event "${event}"`);
    this._events[event].push(fn);
    return this;
  }
  once(event, fn) {
    const wrap = (...a) => { this._events[event] = this._events[event].filter((f) => f !== wrap); return fn(...a); };
    return this.on(event, wrap);
  }
  _fire(event, ...args) { for (const fn of this._events[event]) fn(...args); }

  /** Idempotent — safe to call from every tab. */
  // async so an unsupported environment REJECTS rather than throwing synchronously
  // out of an otherwise-awaitable API.
  async open() {
    this._ensure();
    // open() is idempotent — migrate() is a no-op on an already-current file — so
    // it is the safest thing in the API to retry, and the one the concurrency
    // suite kept having to retry by hand two or three times per run.
    this._opened ??= retryWhenNothingRan(
      () => this._conn.call('open', this._versions),
      { idempotent: true }
    ).then(
      (r) => { this._isOpen = true; this.verno = r.version; this._fire('ready', this); return r; },
      (err) => { this._hasFailed = true; this._opened = null; throw err; }
    );
    return this._opened;
  }

  /**
   * Two forms:
   *   transaction(fn)                    fast path — fn synchronously RECORDS writes,
   *                                      shipped as one atomic batch, one round trip.
   *   transaction(mode, tables, fn)      Dexie-compatible — fn is async and CAN read.
   *                                      Holds an exclusive cross-tab Web Lock plus a
   *                                      real SQLite transaction for its duration.
   */
  async transaction(...args) {
    if (!this._opened) await this.open();
    if (typeof args[0] === 'function') return this._batchTransaction(args[0]);

    const [mode, ...rest] = args;
    const fn = rest.pop();
    if (typeof fn !== 'function') throw new TypeError('granth: transaction() needs a callback');
    // Genuine NESTING only — recognised by the scope object handed to the
    // callback. `_inTx` alone could not tell "nested inside the running
    // transaction" from "started concurrently while it was awaiting", so a
    // second, independent transaction ran bare: no txBegin, no lock, its writes
    // joining the first one's. A REJECTED transaction's write then committed
    // with the other, and a rolled-back one silently took its neighbour's
    // writes with it.
    if (this._isTxScope) return fn(this);

    // Top-level transactions are serialised per tab. Without this, two
    // concurrent calls merge into one SQLite transaction with a single shared
    // _inTx flag between them.
    const previous = this._txChain;
    let releaseChain;
    this._txChain = new Promise((r) => { releaseChain = r; });
    await previous.catch(() => {});

    const run = async () => {
      this._inTx = true;
      // Inherits every table and method; the marker is what makes a nested
      // db.transaction() inside the callback resolvable without async context.
      const scope = Object.create(this);
      scope._isTxScope = true;
      // force = true is safe HERE and only here: we are inside withLock('exclusive'),
      // and the browser releases a dead tab's Web Lock. Holding it proves no live
      // tab owns a transaction, so anything still open belongs to a tab that died
      // and must be rolled back rather than left to swallow everyone's writes.
      await this._conn.call('txBegin', null, String(mode).includes('w') ? 'rw' : 'r', true);
      try {
        const out = await fn(scope);
        await this._conn.call('txCommit');
        return out;
      } catch (err) {
        // Roll back best-effort: if the leader already died, the connection died
        // with it and SQLite rolled back for us.
        await this._conn.call('txRollback').catch(() => {});
        throw err;
      } finally {
        this._inTx = false;
      }
    };

    try {
      const result = await this._conn.withLock('exclusive', run);
      this._emit([...this._tables.keys()], true);
      return result;
    } finally {
      releaseChain();
    }
  }

  async _batchTransaction(fn) {
    const ops: Array<{ op: string; table: string; args: unknown[] }> = [];
    const tx: any = {};
    for (const name of this._tables.keys()) tx[name] = new TxTable(name, ops);
    tx.table = (n) => tx[n];
    const maybe = fn(tx);
    if (maybe && typeof maybe.then === 'function')
      throw new TypeError(
        'granth: the one-argument transaction(fn) callback must be synchronous — it records ' +
          'writes. For reads inside a transaction use transaction(mode, tables, async fn).'
      );
    if (!ops.length) return [];
    return this._ctx.writeBatch(ops);
  }

  /** Subscribe to raw change events. `liveQuery` is usually what you want. */
  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit(tables, broadcast) {
    if (this._inTx) return; // nothing is visible until the transaction commits
    if (broadcast) this._conn?.broadcastChange(tables);
    for (const fn of this._listeners) fn(tables);
  }

  /** 'opfs' or 'indexeddb' — which backend the worker actually got. */
  async storageKind() { this._ensure(); return this._conn.call('storageKind'); }

  /** Bytes the database occupies on disk. Dexie has no equivalent (dexie#689). */
  async size() { this._ensure(); if (!this._opened) await this.open(); return this._conn.call('size'); }

  /**
   * A complete, JSON-safe snapshot. Rows come back in their stored (codec-encoded)
   * form, so `JSON.stringify(await db.export())` round-trips Dates, NaN, Infinity
   * and BigInt losslessly — which decoded documents would not.
   *
   * This is what makes the "always keep a rebuild path" advice actionable.
   */
  async export({ tables }: { tables?: string[] } = {}) {
    if (!this._opened) await this.open();
    const names = tables ?? [...this._tables.keys()];
    const out: Record<string, unknown> = {};
    for (const name of names) out[name] = await this._dispatch('exportTable', [name]);
    return {
      format: 'granth/1',
      database: this.name,
      version: this.verno,
      exportedAt: new Date().toISOString(),
      tables: out,
    };
  }

  /**
   * Restore a snapshot produced by `export()`. Idempotent: rows are written with
   * INSERT OR REPLACE, so re-importing overwrites rather than duplicating.
   */
  async import(dump: any, { clear = false }: { clear?: boolean } = {}) {
    if (!dump || dump.format !== 'granth/1') {
      throw new Error('granth: not a granth export (expected { format: "granth/1" })');
    }
    if (!this._opened) await this.open();
    const counts: Record<string, number> = {};
    for (const [name, payload] of Object.entries(dump.tables ?? {})) {
      if (!this._tables.has(name)) continue;   // table no longer declared; skip loudly below
      if (clear) await this.table(name).clear();
      counts[name] = await this._dispatch('importTable', [name, (payload as { rows?: unknown[] })?.rows ?? []]);
    }
    const skipped = Object.keys(dump.tables ?? {}).filter((n) => !this._tables.has(n));
    if (skipped.length) {
      // eslint-disable-next-line no-console
      console.warn(`granth: import skipped ${skipped.join(', ')} — no matching table in stores()`);
    }
    this._emit(Object.keys(counts), true);
    return counts;
  }

  /** Empty every table without dropping the schema (dexie#1571). */
  async clearAll() {
    if (!this._opened) await this.open();
    const names = [...this._tables.keys()];
    await this._ctx.writeBatch(names.map((table) => ({ op: 'clear', table, args: [] })), names);
    return names;
  }

  /** Force a checkpoint. A no-op on OPFS; on the IndexedDB fallback it persists now. */
  async flush() { this._ensure(); return this._conn.call('flush'); }

  async close() {
    // The IndexedDB fallback checkpoints on a debounce, so closing without a
    // flush can drop the last few hundred milliseconds of writes.
    if (this._isOpen) await this.flush().catch(() => {});
    // Close a transaction this tab was driving. Without this the leader keeps it
    // open and every other tab's writes get absorbed into it and then lost.
    if (this._inTx) await this._conn?.call('txRollback').catch(() => {});
    this._inTx = false;
    // _conn is the real connection. close() used to poke _client and _changes —
    // _client is only ever assigned null and _changes was never assigned at all —
    // so it released nothing: leadership was held until the tab itself died,
    // blocking failover, and the database kept working after "close".
    this._offRemote?.();
    this._offLeader?.();
    this._offLeader = null;
    await this._conn?.close?.();
    this._conn = null;
    this._client = null;
    this._offRemote = null;
    this._listeners.clear();
    this._opened = null;
    this._isOpen = false;
    this._hasBeenClosed = true;
    this._fire('close');
  }

  /** Destroys the OPFS file. Not recoverable. Dexie spells this `delete()`. */
  async deleteDatabase() {
    this._ensure();
    await this._conn.call('deleteDatabase');
    this._opened = null;
    this._isOpen = false;
  }
  delete() { return this.deleteDatabase(); }

  /**
   * Re-runs `querier` whenever the database changes, emitting only when the
   * result actually differs.
   */
  liveQuery(querier, { tables = null, debounceMs = 0 } = {}) {
    const db = this;
    return {
      subscribe(next, error) {
        const on = typeof next === 'function' ? { next, error } : next;
        let last: unknown = Symbol('unset');
        let timer: ReturnType<typeof setTimeout> | undefined;
        let closed = false;
        let running = false;
        let again = false;
        let touched: Set<string> | null = tables ? new Set<string>(tables as string[]) : null;

        async function run() {
          if (closed) return;
          if (running) { again = true; return; }
          running = true;
          const outer = db._tracking;
          const seen = new Set();
          db._tracking = seen;
          try {
            const value = await querier();
            const key = dedupeKey(value);
            if (key !== last) { last = key; if (!closed) on.next?.(value); }
          } catch (err) {
            if (!closed) on.error?.(err);
          } finally {
            db._tracking = outer;
            // Only narrow once we've actually observed a table. An empty set means
            // we learned nothing, so stay subscribed to everything.
            if (!tables && seen.size) touched = touched ? new Set<string>([...touched, ...seen] as string[]) : (seen as Set<string>);
            running = false;
            if (again) { again = false; run(); }
          }
        }

        const off = db.onChange((changed) => {
          if (touched && !changed.some((t: string) => touched!.has(t))) return;
          if (!debounceMs) return run();
          clearTimeout(timer);
          timer = setTimeout(run, debounceMs);
        });

        run();
        // Dual-shaped on purpose:
        //  - Svelte's store contract wants subscribe() to RETURN an unsubscribe function
        //  - RxJS/Angular and Dexie want an object with .unsubscribe()
        // Being both means Svelte, Angular and React need no adapter at all.
        const stop = () => { closed = true; clearTimeout(timer); off(); };
        stop.unsubscribe = stop;
        Object.defineProperty(stop, 'closed', { get: () => closed });
        return stop;
      },
      // Interop so RxJS `from(liveQuery(...))` works (Angular, and Vue via rxjs).
      [(Symbol as any).observable ?? '@@observable']() { return this; },
    };
  }
}

// Dexie exposes these on the instance; mirror it so `db.Table` etc. resolve.
Granth.prototype.Table = Table;
Granth.prototype.Collection = Collection;
Granth.prototype.WhereClause = WhereClause;
Granth.prototype.Version = class Version {};
Granth.prototype.Transaction = class Transaction {};

/** Standalone form, mirroring Dexie: liveQuery(db, () => db.friends.toArray()) */
export function liveQuery(db, querier, opts) {
  return db.liveQuery(querier, opts);
}

export { Table, Collection, WhereClause };

/**
 * Dexie members granth knowingly does not implement, each with the reason.
 * Anything NOT in here and not implemented is a bug, not a decision.
 *
 * Exported rather than left sitting in the test that asserts it, because two
 * things now need the same list and a second copy would drift:
 * `test-compat-audit.mjs` diffs it against the real `dexie` package and fails CI
 * on an un-waived gap, and `granth-mcp` hands it to an assistant that would
 * otherwise reach for these out of Dexie muscle memory and get a TypeError it
 * cannot explain.
 */
export const DEXIE_WAIVERS = {
  'Dexie.unuse': 'no counterpart needed — use() returns a handle, and handle.dispose() detaches that addon',
  'Dexie.backendDB': 'exposes the raw IDBDatabase; there is no IDBDatabase here',
  'Dexie.dynamicallyOpened': 'Dexie-internal',
  'Dexie.vip': 'Dexie PSD/zone internal',
  'Dexie.idbdb': 'the raw IDBDatabase; there is no IndexedDB connection here',
  'Table.defineClass': 'deprecated in Dexie itself; use mapToClass',
  'Collection.raw': 'Dexie-internal escape hatch around hooks/mapToClass',
  'Collection.clone': 'Dexie-internal; our collections are already immutable per step',
};

/**
 * Names granth DOES have that mean something different from Dexie's.
 *
 * A separate list because it is a separate hazard, and the more dangerous one:
 * an absent method throws immediately, while a name that exists with a different
 * contract accepts the call and does the wrong thing.
 *
 * `Dexie.use` sat in the waiver list above for a long time, described as "no
 * equivalent" — while `use()` had been implemented all along as the addon hook.
 * The parity audit could not catch it: it only inspects members Dexie has and
 * granth LACKS, so a waiver for something present is never looked up and never
 * contradicted. `granth-mcp`'s test checks both directions.
 */
export const DEXIE_DIVERGENCES = {
  'Dexie.use':
    'exists, but it is not Dexie middleware. granth has no DBCore layer; db.use(addon) registers before/after ' +
    'hooks and returns a handle with dispose(). A Dexie middleware object passed here will not do what it does in Dexie.',
};

export { LeaderLostError, NoLeaderError } from 'opfs-leader';
export default Granth;

/** Back-compat alias from the pre-1.0 `granthdb` name. */

/** Neutral alias, for code that prefers a generic name. */
export { Granth as Database };
