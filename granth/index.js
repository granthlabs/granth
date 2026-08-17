// Granth — a Dexie-shaped API over SQLite/OPFS, running in one worker,
// coordinated across tabs by opfs-leader.
//
// Client side: builds serializable query plans and RPCs them. No SQL here.
// Behaviour is matched against the real `dexie` package by compat-audit.mjs.

import { createLeaderClient } from 'opfs-leader';

const clone = (p) => ({ ...p, or: p.or.map((g) => ({ and: [...g.and] })) });
const emptyPlan = () => ({ or: [], order: null, offset: 0, limit: null, reverse: false });

/** Read a possibly-dotted keyPath, the way Dexie's getByKeyPath does. */
export function getByKeyPath(obj, keyPath) {
  if (obj == null) return undefined;
  if (!keyPath.includes('.')) return obj[keyPath];
  return keyPath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function defaultCompare(a, b) {
  if (a === b) return 0;
  if (a === undefined) return 1; // undefined sorts last, as in Dexie
  if (b === undefined) return -1;
  return a < b ? -1 : 1;
}

// ---------------------------------------------------------------- Collection

class Collection {
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

  /** Order by an index (or any keyPath — falls back to a client-side sort). */
  _ordered(keyPath) {
    if (this._ctx.hasIndex(this._table, keyPath)) {
      return { coll: this._next((p) => (p.order = { index: keyPath, desc: false })), sortKeyPath: null };
    }
    // Dexie's sortBy accepts any keyPath, not only an index.
    return { coll: this, sortKeyPath: keyPath };
  }

  /** Dexie returns a sorted ARRAY here, not a Collection. */
  async sortBy(keyPath) {
    const { coll, sortKeyPath } = this._ordered(keyPath);
    const rows = await coll.toArray();
    if (!sortKeyPath) return rows;
    return rows.sort((a, b) => defaultCompare(getByKeyPath(a, sortKeyPath), getByKeyPath(b, sortKeyPath)));
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

  async primaryKeys() {
    if (this._clientSide) return (await this.toArray()).map((d) => d[this._ctx.pk(this._table)]);
    return this._ctx.call('query', this._table, this._plan, 'keys');
  }

  /** Dexie's keys() are the INDEX keys, not the primary keys. */
  async keys() {
    if (this._clientSide) {
      const ix = this._ctx.boundIndex(this._table, this._plan);
      return (await this.toArray()).map((d) => getByKeyPath(d, ix));
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
    const ops = [];
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
  constructor(table, plan, ctx, index, filters = [], newGroup = false) {
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
      .reduce((acc, [lo, hi]) => acc.or(this._index).between(lo, hi), this.between(...ranges[0]));
  }

  isNull() { return this._add('isNull', []); }
  notNull() { return this._add('notNull', []); }
}

for (const op of OPS) {
  WhereClause.prototype[op] = function (...values) {
    // anyOf-style operators take a list; equals on a compound index takes the
    // tuple as an array. Both arrive as one array argument that must be spread
    // into params — binding the array itself throws in sqlite-wasm.
    const unwrap = op !== 'notEqual';
    const flat = unwrap && values.length === 1 && Array.isArray(values[0]) ? values[0] : values;
    return this._add(op, flat);
  };
}

// --------------------------------------------------------------------- Table

const HOOK_NAMES = ['creating', 'reading', 'updating', 'deleting'];

class Table {
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
    const plan = emptyPlan();
    plan.or.push({
      and: Object.entries(indexOrCriteria).map(([index, value]) => ({ index, op: 'equals', values: [value] })),
    });
    return new Collection(this.name, plan, this._ctx);
  }

  orderBy(index) { return this._all().orderBy(index); }
  filter(fn) { return this._all().filter(fn); }
  toArray() { return this._all().toArray(); }
  count() { return this._all().count(); }
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
  bulkAdd(docs) { return this._ctx.write('bulkAdd', this.name, docs.map((d) => this._creating(d))); }
  bulkPut(docs) { return this._ctx.write('bulkPut', this.name, docs.map((d) => this._creating(d))); }

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
  constructor(name, { worker, timeoutMs, ...leaderOpts } = {}) {
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
    this._leaderOpts = { worker, timeoutMs, ...leaderOpts };
    this._locks = null;
    this._client = null;
    this._changes = null;

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
      return this._shared(() => this._client.call(method, ...args));
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
  _ensure() {
    if (this._client) return;
    // Honour an injected `locks` (the test seam) rather than only navigator.locks.
    const locks = this._leaderOpts.locks ?? globalThis.navigator?.locks;
    if (typeof locks?.request !== 'function' || typeof globalThis.BroadcastChannel !== 'function') {
      throw new Error(
        'granth: this environment cannot run the database. It needs a browser with ' +
          'Web Locks + Workers in a secure context (HTTPS or localhost). ' +
          'Guard with `if (Granth.isSupported())`, or only touch the db in a client-side effect.'
      );
    }
    this._locks = locks;
    this._client = createLeaderClient({ name: `granth:${this.name}`, ...this._leaderOpts });
    this._changes = new BroadcastChannel(`granth-changes:${this.name}`);
    this._changes.addEventListener('message', (e) => this._emit(e.data.tables, false));
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
  _shared(fn) {
    if (this._inTx || !this._locks?.request) return fn();
    return this._locks.request(`granth-tx:${this.name}`, { mode: 'shared' }, fn);
  }

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
    this._opened ??= this._client.call('open', this._versions).then(
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
    if (this._inTx) return fn(this); // Dexie allows nesting; SQLite has one write txn

    const run = async () => {
      this._inTx = true;
      await this._client.call('txBegin', null, String(mode).includes('w') ? 'rw' : 'r');
      try {
        const out = await fn(this);
        await this._client.call('txCommit');
        return out;
      } catch (err) {
        // Roll back best-effort: if the leader already died, the connection died
        // with it and SQLite rolled back for us.
        await this._client.call('txRollback').catch(() => {});
        throw err;
      } finally {
        this._inTx = false;
      }
    };

    const result = this._locks?.request
      ? await this._locks.request(`granth-tx:${this.name}`, { mode: 'exclusive' }, run)
      : await run();
    this._emit([...this._tables.keys()], true);
    return result;
  }

  async _batchTransaction(fn) {
    const ops = [];
    const tx = {};
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
    if (broadcast) this._changes.postMessage({ tables });
    for (const fn of this._listeners) fn(tables);
  }

  /** 'opfs' or 'indexeddb' — which backend the worker actually got. */
  async storageKind() { this._ensure(); return this._client.call('storageKind'); }

  /** Bytes the database occupies on disk. Dexie has no equivalent (dexie#689). */
  async size() { this._ensure(); if (!this._opened) await this.open(); return this._client.call('size'); }

  /** Empty every table without dropping the schema (dexie#1571). */
  async clearAll() {
    if (!this._opened) await this.open();
    const names = [...this._tables.keys()];
    await this._ctx.writeBatch(names.map((table) => ({ op: 'clear', table, args: [] })), names);
    return names;
  }

  /** Force a checkpoint. A no-op on OPFS; on the IndexedDB fallback it persists now. */
  async flush() { this._ensure(); return this._client.call('flush'); }

  async close() {
    // The IndexedDB fallback checkpoints on a debounce, so closing without a
    // flush can drop the last few hundred milliseconds of writes.
    if (this._isOpen) await this.flush().catch(() => {});
    this._client?.close();
    this._changes?.close();
    this._client = null;
    this._changes = null;
    this._listeners.clear();
    this._opened = null;
    this._isOpen = false;
    this._hasBeenClosed = true;
    this._fire('close');
  }

  /** Destroys the OPFS file. Not recoverable. Dexie spells this `delete()`. */
  async deleteDatabase() {
    this._ensure();
    await this._client.call('deleteDatabase');
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
        let last = Symbol('unset');
        let timer = null;
        let closed = false;
        let running = false;
        let again = false;
        let touched = tables ? new Set(tables) : null;

        async function run() {
          if (closed) return;
          if (running) { again = true; return; }
          running = true;
          const outer = db._tracking;
          const seen = new Set();
          db._tracking = seen;
          try {
            const value = await querier();
            const key = JSON.stringify(value);
            if (key !== last) { last = key; if (!closed) on.next?.(value); }
          } catch (err) {
            if (!closed) on.error?.(err);
          } finally {
            db._tracking = outer;
            // Only narrow once we've actually observed a table. An empty set means
            // we learned nothing, so stay subscribed to everything.
            if (!tables && seen.size) touched = touched ? new Set([...touched, ...seen]) : seen;
            running = false;
            if (again) { again = false; run(); }
          }
        }

        const off = db.onChange((changed) => {
          if (touched && !changed.some((t) => touched.has(t))) return;
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
      [Symbol.observable ?? '@@observable']() { return this; },
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


export { VersionError } from './engine.js';
export { LeaderLostError, NoLeaderError } from 'opfs-leader';
export default Granth;

/** Back-compat alias from the pre-1.0 `granth` name. */

/** Neutral alias, for code that prefers a generic name. */
export { Granth as Database };
