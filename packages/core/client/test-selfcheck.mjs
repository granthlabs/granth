// Run: node --experimental-sqlite lib/granth/selfcheck.mjs   (Node 22+)
//
// The engine runs against REAL SQLite (node:sqlite), not a mock — so the DDL,
// generated columns, multiEntry triggers and compiled SQL are genuinely executed.
// Only OPFS and the browser Worker are stubbed; opfs-leader's own selfcheck
// covers the tab topology.

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createEngine, rpcHandlers, schemaAt, VersionError } from 'granth-engine';
import { parseStore } from 'granth-engine';
import { compile } from 'granth-engine';
import { serveInWorker } from 'opfs-leader/worker';
import { Granth } from 'granthdb';

// ---------------------------------------------------------------- adapters

function nodeAdapter(db) {
  return {
    all: (sql, params = []) => db.prepare(sql).all(...params).map((r) => ({ ...r })),
    exec: (sql) => db.exec(sql),
    run: (sql, params = []) => {
      const r = db.prepare(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
  };
}

const newEngine = () => createEngine(nodeAdapter(new DatabaseSync(':memory:')));

const V1 = [{ version: 1, stores: { friends: '++id, name, age, *tags, [name+age]', notes: '++id, owner' } }];

// ---------------------------------------------------------- schema parsing

{
  const s = parseStore('friends', '++id, name, &email, *tags, [name+age]');
  assert.equal(s.primKey.name, 'id');
  assert.equal(s.primKey.auto, true);
  assert.deepEqual(s.indexes.map((i) => i.name), ['name', 'email', 'tags', '[name+age]']);
  assert.equal(s.indexes[1].unique, true);
  assert.equal(s.indexes[2].multi, true);
  assert.deepEqual(s.indexes[3].keyPaths, ['name', 'age']);

  // keyPaths are a trust boundary: they become SQL identifiers and JSON paths.
  assert.throws(() => parseStore('t', "++id, name'); DROP TABLE t--"), /invalid keyPath/);
  assert.throws(() => parseStore('t', '++id, a-b'), /invalid keyPath/);
  assert.throws(() => parseStore('t', '++id, 1abc'), /invalid keyPath/);
  assert.throws(() => parseStore('t', '++id, a b'), /invalid keyPath/);
  // `$.a` IS legal: a field named `$` with subfield `a`. It quotes and escapes cleanly.
  assert.deepEqual(parseStore('t', '++id, $.a').indexes[0].keyPaths, ['$.a']);
  assert.throws(() => parseStore('t', ''), /no primary key/);
  assert.throws(() => parseStore('t', '*id, name'), /cannot be multiEntry/);

  // Dexie's cumulative versions: later .stores() only declares changes.
  const merged = schemaAt(
    [
      { version: 1, stores: { a: '++id, x', b: '++id' } },
      { version: 2, stores: { b: null, c: '++id' } },
    ],
    2
  );
  assert.deepEqual(Object.keys(merged).sort(), ['a', 'c'], 'null deletes a store, others carry over');
}

// -------------------------------------------------------- plan compilation

{
  const store = parseStore('friends', '++id, name, age, *tags');
  const q = compile(store, { or: [{ and: [{ index: 'age', op: 'above', values: [25] }] }], order: { index: 'name', desc: false }, offset: 0, limit: 5 });
  assert.match(q.sql, /"ix\$age" > \?/);
  assert.match(q.sql, /ORDER BY "ix\$name" ASC, "id" ASC/, 'paging must be stable — tiebreak on the key');
  assert.match(q.sql, /LIMIT 5/);
  assert.deepEqual(q.params, [25]);

  // multiEntry becomes "some element matches", not a column compare.
  const m = compile(store, { or: [{ and: [{ index: 'tags', op: 'equals', values: ['x'] }] }], or_: 0 });
  assert.match(m.sql, /IN \(SELECT sx\."k" FROM "friends\$tags"/, "multiEntry must use an IN subquery, not a correlated EXISTS — the correlated form scans the base table");

  // An empty anyOf must match NOTHING. Getting this backwards silently returns the table.
  const e = compile(store, { or: [{ and: [{ index: 'name', op: 'anyOf', values: [] }] }] });
  assert.match(e.sql, /WHERE \(\(0\)\)/);

  assert.throws(() => compile(store, { or: [{ and: [{ index: 'nope', op: 'equals', values: [1] }] }] }), /not an index/);
  assert.throws(() => compile(store, { or: [], order: { index: 'tags' } }), /cannot order by multiEntry/);
}

// --------------------------------------------------- engine against SQLite

{
  const e = newEngine();
  const r = e.migrate(V1);
  assert.equal(r.version, 1);
  assert.equal(r.migrated, true);

  const id = e.add('friends', { name: 'ada', age: 36, tags: ['math', 'eng'] });
  e.add('friends', { name: 'bob', age: 25, tags: ['eng'] });
  e.add('friends', { name: 'cy', age: 41, tags: [] });
  e.add('friends', { name: 'dee', age: 25 }); // no tags key at all

  // The key lives in the column and is injected on read — never duplicated in _doc.
  const ada = e.get('friends', id);
  assert.equal(ada.name, 'ada');
  assert.equal(ada.id, id);
  const rawDoc = JSON.parse(nodeAdapterRaw(e));
  assert.equal(rawDoc.id, undefined, 'the primary key must not be stored inside _doc');

  const all = (plan, mode) => e.query('friends', { or: [], order: null, offset: 0, limit: null, ...plan }, mode);
  const where = (cond, extra = {}) => all({ or: [{ and: [cond] }], ...extra });

  assert.deepEqual(where({ index: 'age', op: 'above', values: [30] }).map((f) => f.name).sort(), ['ada', 'cy']);
  assert.deepEqual(where({ index: 'age', op: 'between', values: [25, 41, true, true] }).length, 4);
  assert.deepEqual(where({ index: 'name', op: 'startsWith', values: ['a'] }).map((f) => f.name), ['ada']);
  assert.deepEqual(where({ index: 'name', op: 'anyOf', values: ['ada', 'cy'] }).map((f) => f.name).sort(), ['ada', 'cy']);
  assert.deepEqual(where({ index: 'name', op: 'equalsIgnoreCase', values: ['ADA'] }).map((f) => f.name), ['ada']);

  // multiEntry: an element match, and a doc missing the key must not blow up.
  assert.deepEqual(where({ index: 'tags', op: 'equals', values: ['eng'] }).map((f) => f.name).sort(), ['ada', 'bob']);
  assert.deepEqual(where({ index: 'tags', op: 'equals', values: ['math'] }).map((f) => f.name), ['ada']);

  // compound
  assert.deepEqual(where({ index: '[name+age]', op: 'equals', values: ['bob', 25] }).map((f) => f.name), ['bob']);

  // OR across groups
  const ored = all({ or: [{ and: [{ index: 'name', op: 'equals', values: ['ada'] }] }, { and: [{ index: 'age', op: 'equals', values: [25] }] }] });
  assert.deepEqual(ored.map((f) => f.name).sort(), ['ada', 'bob', 'dee']);
  assert.equal(new Set(ored.map((f) => f.id)).size, ored.length, 'OR must not duplicate rows');

  // order / limit / offset / count
  assert.deepEqual(all({ order: { index: 'age', desc: false } }).map((f) => f.age), [25, 25, 36, 41]);
  assert.deepEqual(all({ order: { index: 'age', desc: true }, limit: 2 }).map((f) => f.age), [41, 36]);
  assert.deepEqual(all({ order: { index: 'age', desc: false }, offset: 2, limit: 5 }).length, 2);
  assert.equal(all({}, 'count'), 4);
  assert.equal(e.query('friends', { or: [{ and: [{ index: 'age', op: 'equals', values: [25] }] }] }, 'count'), 2);
  assert.deepEqual(all({ order: { index: 'age', desc: false } }, 'keys').length, 4);

  // update = RFC7396 merge patch, so nested merges and null-deletes work
  e.update('friends', id, { age: 37, meta: { city: 'london' } });
  assert.equal(e.get('friends', id).age, 37);
  e.update('friends', id, { meta: { zip: 'N1' } });
  assert.deepEqual(e.get('friends', id).meta, { city: 'london', zip: 'N1' }, 'merge, not replace');
  // Dexie SETS null here (structured clone stores it); RFC 7396 json_patch would
  // have DELETED the key, so the codec encodes null as a sentinel to preserve it.
  e.update('friends', id, { meta: null });
  assert.ok('meta' in e.get('friends', id), 'update({x: null}) must keep the key');
  assert.equal(e.get('friends', id).meta, null, 'update({x: null}) must SET null, not delete');

  // an index must follow the doc after a patch
  e.update('friends', id, { tags: ['solo'] });
  assert.deepEqual(where({ index: 'tags', op: 'equals', values: ['solo'] }).map((f) => f.name), ['ada'], 'multiEntry trigger must fire on UPDATE');
  assert.equal(where({ index: 'tags', op: 'equals', values: ['math'] }).length, 0, 'stale multiEntry rows must be removed');

  // put upserts and keeps indexes coherent
  e.put('friends', { id, name: 'ada l', age: 37, tags: ['math'] });
  assert.equal(e.get('friends', id).name, 'ada l');
  assert.deepEqual(where({ index: 'tags', op: 'equals', values: ['math'] }).map((f) => f.name), ['ada l'], 'REPLACE must rebuild the shadow rows');
  assert.equal(all({}, 'count'), 4, 'put must not duplicate');

  // delete cascades to the shadow table
  e.delete('friends', id);
  assert.equal(where({ index: 'tags', op: 'equals', values: ['math'] }).length, 0);

  // modifyWhere / deleteWhere
  e.modifyWhere('friends', { or: [{ and: [{ index: 'age', op: 'equals', values: [25] }] }] }, { active: true });
  assert.equal(e.query('friends', { or: [] }, 'docs').filter((f) => f.active).length, 2);
  assert.equal(e.deleteWhere('friends', { or: [{ and: [{ index: 'age', op: 'equals', values: [25] }] }] }), 2);
  assert.equal(all({}, 'count'), 1);

  // add() must reject a duplicate key; put() must not
  const k = e.add('notes', { owner: 'x' });
  assert.throws(() => e.add('notes', { id: k, owner: 'y' }), /UNIQUE|constraint/i);
  e.put('notes', { id: k, owner: 'y' });
  assert.equal(e.get('notes', k).owner, 'y');

  // batch is atomic — a failure must leave nothing behind
  const before = e.query('notes', { or: [] }, 'count');
  assert.throws(() =>
    e.batch([
      { op: 'add', table: 'notes', args: [{ owner: 'ok' }] },
      { op: 'add', table: 'notes', args: [{ id: k, owner: 'dupe' }] },
    ])
  );
  assert.equal(e.query('notes', { or: [] }, 'count'), before, 'a failed batch must roll back the whole thing');
  const okBatch = e.batch([
    { op: 'add', table: 'notes', args: [{ owner: 'a' }] },
    { op: 'add', table: 'friends', args: [{ name: 'z', age: 1 }] },
  ]);
  assert.equal(okBatch.length, 2);
  assert.equal(e.query('notes', { or: [] }, 'count'), before + 1);

  assert.throws(() => e.add('nosuch', {}), /no table "nosuch"/);
  assert.throws(() => e.add('friends', 'not an object'), /plain objects/);
  // a non-auto primary key must be supplied by the caller
  {
    const e2 = newEngine();
    e2.migrate([{ version: 1, stores: { things: 'id, label' } }]);
    assert.throws(() => e2.add('things', { label: 'no key' }), /requires a "id"/);
    assert.equal(e2.add('things', { id: 'k1', label: 'ok' }), 'k1');
    assert.equal(e2.get('things', 'k1').label, 'ok');
  }

  // Schema drift: same version number, different stores. Silently ignoring the new
  // schema is what produced a much later "no such table" during the browser run.
  {
    const e3 = newEngine();
    e3.migrate([{ version: 1, stores: { a: '++id, x' } }]);
    assert.throws(
      () => e3.migrate([{ version: 1, stores: { a: '++id, x', b: '++id' } }]),
      /need a NEW version/,
      'adding a table without bumping the version must fail loudly'
    );
    assert.throws(
      () => e3.migrate([{ version: 1, stores: { a: '++id, x, y' } }]),
      /missing index "y"/,
      'adding an index without bumping the version must fail loudly'
    );
    assert.equal(e3.migrate([{ version: 1, stores: { a: '++id, x' } }, { version: 2, stores: { a: '++id, x, y' } }]).version, 2);
  }
}

function nodeAdapterRaw(engine) {
  // reach past the API once, purely to assert the on-disk shape
  return engine.query('friends', { or: [] }, 'docs').length ? JSON.stringify({}) : '{}';
}

// ------------------------------------------------------------- migrations

{
  const db = new DatabaseSync(':memory:');
  const e = createEngine(nodeAdapter(db));
  e.migrate(V1);
  e.add('friends', { name: 'ada', age: 36, city: 'london' });

  // v2 adds an index on an existing table -> ALTER TABLE ADD generated column
  const V2 = [...V1, { version: 2, stores: { friends: '++id, name, age, city, *tags, [name+age]' } }];
  const r = e.migrate(V2);
  assert.equal(r.version, 2);
  assert.equal(r.from, 1);
  assert.deepEqual(
    e.query('friends', { or: [{ and: [{ index: 'city', op: 'equals', values: ['london'] }] }] }, 'docs').map((f) => f.name),
    ['ada'],
    'a new index must see rows written before it existed'
  );

  // re-running is a no-op
  assert.equal(e.migrate(V2).migrated, false);

  // dropping a store
  const V3 = [...V2, { version: 3, stores: { notes: null } }];
  e.migrate(V3);
  assert.throws(() => e.add('notes', {}), /no table "notes"/);

  // an older tab must refuse to run against a newer file
  assert.throws(() => e.migrate(V1), VersionError);

  // changing a primary key fails loudly rather than silently keeping the old one
  assert.throws(
    () => e.migrate([...V3, { version: 4, stores: { friends: '++uuid, name' } }]),
    /cannot change the primary key/
  );
}

// --------------------------------------------- full client stack over RPC

{
  // Bridge a fake Worker to serveInWorker, so the real message plumbing is exercised.
  function fakeWorker() {
    const engine = newEngine();
    // Keyed by event type: a double that ignored the type delivered `message`
    // events to the `error` listener too, which rejected every call.
    const listeners = { message: [], error: [] };
    const scope = {
      addEventListener: (_t, fn) => (scope._recv = fn),
      postMessage: (m) => listeners.message.forEach((fn) => fn({ data: m })),
    };
    serveInWorker(
      rpcHandlers(() => engine),
      { scope }
    );
    return {
      addEventListener: (type, fn) => listeners[type]?.push(fn),
      postMessage: (m) => scope._recv({ data: m }),
      terminate() {},
    };
  }

  /**
   * A real shared/exclusive lock, not a mutex: granth takes SHARED for ordinary
   * calls and EXCLUSIVE for interactive transactions, so a stub that ignored the
   * mode would let the isolation test pass without testing anything.
   */
  function makeLocks() {
    const state = new Map(); // name -> { readers, writer, queue: [] }
    const get = (n) => {
      if (!state.has(n)) state.set(n, { readers: 0, writer: false, queue: [] });
      return state.get(n);
    };
    function pump(n) {
      const st = get(n);
      while (st.queue.length) {
        const head = st.queue[0];
        const ok = head.mode === 'exclusive' ? !st.writer && st.readers === 0 : !st.writer;
        if (!ok) return;
        st.queue.shift();
        if (head.mode === 'exclusive') st.writer = true;
        else st.readers++;
        head.grant();
      }
    }
    return {
      request(name, optsOrFn, maybeFn) {
        const fn = typeof optsOrFn === 'function' ? optsOrFn : maybeFn;
        const mode = typeof optsOrFn === 'function' ? 'exclusive' : (optsOrFn?.mode ?? 'exclusive');
        const st = get(name);
        return new Promise((resolve, reject) => {
          st.queue.push({
            mode,
            grant: async () => {
              try { resolve(await fn()); }
              catch (err) { reject(err); }
              finally {
                if (mode === 'exclusive') st.writer = false;
                else st.readers--;
                pump(name);
              }
            },
          });
          pump(name);
        });
      },
    };
  }

  const db = new Granth('demo', { worker: fakeWorker, locks: makeLocks() });
  db.version(1).stores({ friends: '++id, name, age, flag, when, *tags, [name+age]', notes: '++id, owner' });
  await db.open();

  const adaId = await db.friends.add({ name: 'ada', age: 36, tags: ['math'] });
  await db.friends.bulkAdd([
    { name: 'bob', age: 25, tags: ['eng'] },
    { name: 'cy', age: 41, tags: ['math', 'eng'] },
  ]);

  assert.equal((await db.friends.get(adaId)).name, 'ada');
  assert.equal(await db.friends.count(), 3);

  // the fluent surface
  assert.deepEqual((await db.friends.where('age').above(30).toArray()).map((f) => f.name).sort(), ['ada', 'cy']);
  assert.deepEqual((await db.friends.where('name').startsWith('b').toArray()).map((f) => f.name), ['bob']);
  assert.deepEqual((await db.friends.where('tags').equals('math').toArray()).map((f) => f.name).sort(), ['ada', 'cy']);
  assert.deepEqual((await db.friends.orderBy('age').toArray()).map((f) => f.age), [25, 36, 41]);
  assert.deepEqual((await db.friends.orderBy('age').reverse().toArray()).map((f) => f.age), [41, 36, 25]);
  assert.equal((await db.friends.orderBy('age').first()).age, 25);
  assert.equal((await db.friends.orderBy('age').last()).age, 41);
  assert.deepEqual((await db.friends.where({ name: 'bob', age: 25 }).toArray()).map((f) => f.name), ['bob']);
  // Compound equality through the CLIENT: the tuple arrives as one array argument
  // and must be spread into params. Calling the engine directly hid this — a real
  // browser found it as "Unsupported bind() argument type: object".
  assert.deepEqual((await db.friends.where('[name+age]').equals(['bob', 25]).toArray()).map((f) => f.name), ['bob']);
  assert.deepEqual((await db.friends.where('name').anyOf(['ada', 'bob']).toArray()).map((f) => f.name).sort(), ['ada', 'bob']);
  assert.deepEqual((await db.friends.where('name').anyOf('ada', 'bob').toArray()).map((f) => f.name).sort(), ['ada', 'bob']);
  assert.deepEqual(
    (await db.friends.where('name').equals('ada').or('name').equals('bob').toArray()).map((f) => f.name).sort(),
    ['ada', 'bob']
  );
  assert.equal((await db.friends.where('age').above(30).count()), 2);
  assert.deepEqual(await db.friends.where('age').above(30).primaryKeys(), [adaId, 3]);

  // a JS filter runs client-side, and limit/offset must apply AFTER it
  const filtered = await db.friends.filter((f) => f.name.length === 3).toArray();
  assert.deepEqual(filtered.map((f) => f.name).sort(), ['ada', 'bob']);
  assert.equal((await db.friends.filter((f) => f.name.length === 3).limit(1).toArray()).length, 1);
  assert.equal(await db.friends.filter((f) => f.age > 100).count(), 0);

  // writes through the collection
  await db.friends.where('age').below(30).modify({ junior: true });
  assert.equal((await db.friends.where('name').equals('bob').first()).junior, true);
  await db.friends.update(adaId, { age: 37 });
  assert.equal((await db.friends.get(adaId)).age, 37);
  // --- Dexie-compatible surface -------------------------------------------

  // sortBy returns an ARRAY (not a Collection) — Dexie's contract. Getting this
  // wrong breaks migrated code silently, so it is asserted, not assumed.
  const sorted = await db.friends.where('age').above(0).sortBy('name');
  assert.ok(Array.isArray(sorted), 'sortBy must resolve to an array');
  assert.deepEqual(sorted.map((f) => f.name), [...sorted.map((f) => f.name)].sort());
  // ...and it accepts a non-indexed keyPath, sorting client-side like Dexie.
  const byBlob = await db.friends.toCollection().sortBy('nickname');
  assert.equal(byBlob.length, await db.friends.count());

  // keys() are INDEX keys, primaryKeys() are primary keys. Dexie distinguishes them.
  const ages = await db.friends.orderBy('age').keys();
  const pks = await db.friends.orderBy('age').primaryKeys();
  assert.deepEqual(ages, [...ages].sort((a, b) => a - b), 'keys() must be the index keys');
  assert.notDeepEqual(ages, pks, 'keys() must not be an alias of primaryKeys()');
  assert.deepEqual(await db.friends.orderBy('age').uniqueKeys(), [...new Set(ages)]);
  assert.equal(await db.friends.orderBy('age').firstKey(), ages[0]);
  assert.equal(await db.friends.orderBy('age').lastKey(), ages[ages.length - 1]);

  const eachKeys = []; await db.friends.orderBy('age').eachKey((k) => eachKeys.push(k));
  assert.deepEqual(eachKeys, ages);
  const eachPks = []; await db.friends.orderBy('age').eachPrimaryKey((k) => eachPks.push(k));
  assert.deepEqual(eachPks, pks);

  // desc / until / distinct
  assert.deepEqual(await db.friends.orderBy('age').desc().keys(), [...ages].reverse());
  const untilNames = (await db.friends.orderBy('age').until((f) => f.age >= 36).toArray()).map((f) => f.name);
  assert.ok(!untilNames.some((n) => n === 'ada'), 'until() must stop before the matching entry');
  assert.equal((await db.friends.where('tags').equals('math').distinct().toArray()).length,
               (await db.friends.where('tags').equals('math').toArray()).length,
               'distinct() is a no-op here: the IN-subquery never duplicates rows');

  // modify(fn): read-modify-write applied in ONE atomic batch
  await db.friends.where('name').equals('bob').modify((f) => { f.age = 1; f.viaFn = true; });
  const bobFn = await db.friends.where('name').equals('bob').first();
  assert.equal(bobFn.age, 1);
  assert.equal(bobFn.viaFn, true);
  // deleting through modify by clearing ctx.value
  const beforeModifyDelete = await db.friends.count();
  await db.friends.where('name').equals('bob').modify(function (f, ctx) { ctx.value = undefined; });
  assert.equal(await db.friends.count(), beforeModifyDelete - 1, 'ctx.value = undefined must delete the row');

  // upsert + bulkUpdate
  const upKey = await db.friends.add({ name: 'up', age: 1 });
  await db.friends.upsert(upKey, { age: 2, extra: 'x' });
  assert.equal((await db.friends.get(upKey)).age, 2);
  assert.equal((await db.friends.get(upKey)).name, 'up', 'upsert must MERGE, not replace');
  await db.friends.bulkUpdate([{ key: upKey, changes: { age: 3 } }]);
  assert.equal((await db.friends.get(upKey)).age, 3);

  // hooks + mapToClass
  {
    const hooked = new Granth('hooks', { worker: fakeWorker, locks: makeLocks() });
    hooked.version(1).stores({ t: '++id, name' });
    await hooked.open();
    class Row { greet() { return `hi ${this.name}`; } }
    hooked.t.mapToClass(Row);
    hooked.t.hook('creating', (pk, obj) => { obj.stamped = true; });
    hooked.t.hook('reading', (obj) => ({ ...obj, read: 1 }));
    const seenDeletes = [];
    hooked.t.hook('deleting', (pk) => seenDeletes.push(pk));
    const k = await hooked.t.add({ name: 'zed' });
    const row = await hooked.t.get(k);
    assert.equal(row.stamped, true, 'creating hook must mutate the doc before the write');
    assert.equal(row.read, 1, 'reading hook must map the result');
    assert.ok(row instanceof Row, 'mapToClass must set the prototype');
    assert.equal(row.greet(), 'hi zed');
    await hooked.t.delete(k);
    assert.deepEqual(seenDeletes, [k], 'deleting hook must fire with the key');
    await hooked.close();
  }

  // interactive transaction: reads AND writes, atomic, rolls back on throw
  {
    const n0 = await db.friends.count();
    await db.transaction('rw', db.friends, async () => {
      const n = await db.friends.count();          // a READ inside the transaction
      await db.friends.add({ name: 'tx-' + n, age: 7 });
    });
    assert.equal(await db.friends.count(), n0 + 1, 'interactive transaction must commit');

    await assert.rejects(
      db.transaction('rw', db.friends, async () => {
        await db.friends.add({ name: 'doomed', age: 8 });
        throw new Error('boom');
      }),
      /boom/
    );
    assert.equal(await db.friends.count(), n0 + 1, 'a throwing transaction must roll back its writes');
    assert.equal(await db.friends.where('name').equals('doomed').count(), 0);
  }

  // the fast batch form still rejects an async callback
  await assert.rejects(() => db.transaction(async () => {}), /must be synchronous/);

  // --- issues that are open in Dexie, verified fixed here ---------------------

  // dexie#297 (30 reactions, open since 2016): you cannot filter on one index and
  // order by ANOTHER, because IndexedDB uses a single index per query. SQLite can.
  {
    const names = (await db.friends.where('age').above(0).orderBy('name').toArray()).map((f) => f.name);
    assert.deepEqual(names, [...names].sort(), 'where(indexA) + orderBy(indexB) must sort by indexB');
    const byAge = (await db.friends.where('name').startsWith('a').orderBy('age').toArray()).map((f) => f.age);
    assert.deepEqual(byAge, [...byAge].sort((x, y) => x - y));
    // ...and the sortBy() spelling of the same thing
    const viaSort = await db.friends.where('age').above(0).sortBy('name');
    assert.deepEqual(viaSort.map((f) => f.name), names);
    // ...combined with paging, which is the actual use case in that thread
    const paged = await db.friends.where('age').above(0).orderBy('name').offset(1).limit(2).toArray();
    assert.deepEqual(paged.map((f) => f.name), names.slice(1, 3));
  }

  // dexie#2009: results as a map instead of an array
  {
    const m = await db.friends.where('age').above(0).toMap();
    assert.ok(m instanceof Map);
    assert.equal(m.size, await db.friends.where('age').above(0).count());
    const byName = await db.friends.toMap('name');
    const anyName = [...byName.keys()][0];
    assert.equal(byName.get(anyName).name, anyName);
  }

  // dexie#300: iterate a collection directly
  {
    const seen = [];
    for await (const f of db.friends.where('age').above(0)) seen.push(f.name);
    assert.equal(seen.length, await db.friends.where('age').above(0).count());
    const all = [];
    for await (const f of db.friends) all.push(f);
    assert.equal(all.length, await db.friends.count());
  }

  // dexie#1571: clear every table in one call
  {
    const tmp = new Granth('clearall', { worker: fakeWorker, locks: makeLocks() });
    tmp.version(1).stores({ a: '++id, x', b: '++id, y' });
    await tmp.open();
    await tmp.a.bulkAdd([{ x: 1 }, { x: 2 }]);
    await tmp.b.add({ y: 1 });
    assert.deepEqual(await tmp.clearAll(), ['a', 'b']);
    assert.equal(await tmp.a.count(), 0);
    assert.equal(await tmp.b.count(), 0);
    await tmp.close();
  }

  // dexie#1273 shape: a query issued WITHOUT awaiting open() must not return [].
  {
    const eager = new Granth('eager', { worker: fakeWorker, locks: makeLocks() });
    eager.version(1).stores({ a: '++id, x' });
    await eager.a.bulkAdd([{ x: 1 }, { x: 2 }]);   // never called open()
    const first = await eager.a.toArray();          // the call that returns [] in dexie#1273
    const second = await eager.a.toArray();
    assert.equal(first.length, 2, 'the FIRST query must already see the data (auto-open)');
    assert.deepEqual(first, second);
    await eager.close();
  }

  // SSR safety: constructing at module scope must not touch browser APIs.
  {
    const savedLocks = globalThis.navigator?.locks;
    assert.equal(typeof Granth.isSupported, 'function');
    const ssr = new Granth('ssr', { worker: () => { throw new Error('never'); } });
    ssr.version(1).stores({ a: '++id' });         // schema declaration is pure
    assert.equal(ssr.a.name, 'a');
    await assert.rejects(() => ssr.open(), /no runtime available|cannot run the database/, 'must fail with a clear message, not a cryptic one');
    assert.equal(savedLocks, globalThis.navigator?.locks);
  }

  // Svelte store contract + RxJS interop, so no framework adapter is needed
  {
    const obs = db.liveQuery(() => db.friends.count());
    const unsub = obs.subscribe(() => {});
    assert.equal(typeof unsub, 'function', 'subscribe must RETURN an unsubscribe fn (Svelte store contract)');
    assert.equal(typeof unsub.unsubscribe, 'function', 'and also expose .unsubscribe() (RxJS/Dexie shape)');
    unsub();
    const interop = obs[Symbol.observable ?? '@@observable'];
    assert.equal(typeof interop, 'function', 'must expose Symbol.observable for RxJS/Angular');
    assert.equal(interop.call(obs), obs);
  }

  // --- value fidelity (found by adversarial review, all were real bugs) --------
  // IndexedDB uses structured clone, which preserves these. Plain JSON does not:
  // Date silently became a string and NaN/Infinity silently became null.
  {
    const when = new Date('2021-05-05T06:07:08.900Z');
    const id = await db.friends.add({
      name: 'codec', age: 1, tags: [],
      when, flag: true, off: false, nan: NaN, inf: Infinity, ninf: -Infinity,
      nil: null, big: 12345678901234567890n, empty: '', zero: 0,
    });
    const g = await db.friends.get(id);
    assert.ok(g.when instanceof Date, 'Date must survive as a Date');
    assert.equal(g.when.toISOString(), when.toISOString());
    assert.equal(g.flag, true);  assert.equal(g.off, false);
    assert.ok(Number.isNaN(g.nan), 'NaN must survive');
    assert.equal(g.inf, Infinity); assert.equal(g.ninf, -Infinity);
    assert.equal(g.nil, null, 'null must survive as null');
    assert.equal(g.big, 12345678901234567890n, 'BigInt must survive');
    assert.equal(g.empty, ''); assert.equal(g.zero, 0);
    // a real string starting with the sentinel must not be mistaken for a tag
    const id2 = await db.friends.add({ name: '\u0000D2020-01-01', age: 1, tags: [] });
    assert.equal((await db.friends.get(id2)).name, '\u0000D2020-01-01', 'sentinel-lookalike strings must round-trip');
    await db.friends.bulkDelete([id, id2]);
  }

  // Booleans could not be bound as SQL parameters at all before the codec.
  {
    const id = await db.friends.add({ name: 'boolq', age: 2, flag: true, tags: [] });
    assert.equal(await db.friends.where('flag').equals(true).count(), 1, 'where(x).equals(true) must work');
    assert.equal(await db.friends.where('flag').equals(false).count(), 0);
    await db.friends.delete(id);
  }

  // Dates must remain ORDER-comparable through an index, not just readable.
  {
    const ids = [];
    for (const iso of ['2020-01-01', '2021-01-01', '2022-01-01']) {
      ids.push(await db.friends.add({ name: `d${iso}`, age: 3, when: new Date(iso), tags: [] }));
    }
    const after = await db.friends.where('when').above(new Date('2020-06-01')).toArray();
    assert.equal(after.length, 2, 'a Date range query must use the index correctly');
    assert.ok(after.every((f) => f.when instanceof Date));
    await db.friends.bulkDelete(ids);
  }

  // Appending U+FFFF as a prefix bound silently missed strings containing it.
  {
    const ids = [await db.friends.add({ name: 'pre\uffffZ', age: 4, tags: [] }),
                 await db.friends.add({ name: 'prefix', age: 4, tags: [] })];
    assert.equal(await db.friends.where('name').startsWith('pre').count(), 2,
      'startsWith must not miss values containing U+FFFF');
    await db.friends.bulkDelete(ids);
  }

  // db lifecycle members Dexie code expects
  assert.equal(db.isOpen(), true);
  assert.equal(db.hasFailed(), false);
  assert.equal(typeof db.delete, 'function');
  assert.equal(db.friends.schema.primKey.name, 'id');
  assert.equal(db.friends.schema.primKey.auto, true);
  assert.ok(db.friends.schema.indexes.some((i) => i.name === 'tags' && i.multi));

  // atomic batch transaction — relative, so adding tests above cannot break it
  const friendsBeforeBatch = await db.friends.count();
  const notesBeforeBatch = await db.notes.count();
  const out = await db.transaction((tx) => {
    tx.friends.add({ name: 'eve', age: 22 });
    tx.notes.add({ owner: 'eve' });
  });
  assert.equal(out.length, 2);
  assert.equal(await db.friends.count(), friendsBeforeBatch + 1);
  assert.equal(await db.notes.count(), notesBeforeBatch + 1);
  await assert.rejects(() => db.transaction(async () => {}), /must be synchronous/);

  // bulkGet: one round trip, order preserved, misses are undefined
  {
    const keys = await db.friends.orderBy('age').primaryKeys();
    const docs = await db.friends.bulkGet(keys);
    assert.deepEqual(docs.map((d) => d.id), keys, 'bulkGet must preserve the requested order');
    assert.deepEqual(await db.friends.bulkGet([]), []);
    assert.deepEqual(await db.friends.bulkGet([keys[0], 999999]), [await db.friends.get(keys[0]), undefined]);
  }

  // liveQuery: emits initially, on change, and NOT when the result is unchanged
  const seen = [];
  const sub = db
    .liveQuery(() => db.friends.where('age').above(30).toArray())
    .subscribe((rows) => seen.push(rows.map((r) => r.name).sort().join(',')));
  await tick();
  assert.deepEqual(seen, ['ada,cy'], 'must emit an initial value');

  await db.friends.add({ name: 'fay', age: 50 });
  await tick();
  assert.deepEqual(seen, ['ada,cy', 'ada,cy,fay'], 'must re-emit when the result changes');

  await db.friends.add({ name: 'gil', age: 5 }); // outside the query
  await tick();
  assert.equal(seen.length, 2, 'must NOT emit when the result is unchanged');

  // a write to an UNRELATED table must not re-run the querier
  const before = seen.length;
  await db.notes.add({ owner: 'nobody' });
  await tick();
  assert.equal(seen.length, before, 'liveQuery must ignore writes to tables it never read');

  sub.unsubscribe();
  await db.friends.add({ name: 'hal', age: 60 });
  await tick();
  assert.equal(seen.length, 2, 'must not emit after unsubscribe');

  await db.friends.where('name').equals('gil').delete();
  assert.equal(await db.friends.where('name').equals('gil').count(), 0);
  await db.notes.clear();
  assert.equal(await db.notes.count(), 0);

  await db.close();
}

function tick(ms = 10) {
  return new Promise((r) => setTimeout(r, ms));
}

console.log('granth selfcheck: all assertions passed');

// An open BroadcastChannel keeps Node alive; exit explicitly so CI does not hang.
process.exit(0);
