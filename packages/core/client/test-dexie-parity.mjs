// Differential test: run the SAME script against real Dexie and against granth,
// then diff the answers.
//
// WHY THIS EXISTS: test-compat-audit.mjs walks method NAMES, so a method that
// exists and returns the wrong thing passes it. Every defect in KNOWN-DEFECTS.md
// was invisible to the whole suite for exactly that reason — including one that
// DELETED A ROW. Asserting against hand-written expectations would have the same
// hole, because the expectations come from the same head that wrote the bug.
// Dexie is the specification; this file asks it directly.
//
// A case that granth is knowingly allowed to differ on carries `allow:` with the
// reason. Anything else must match byte for byte.

import 'fake-indexeddb/auto';
import DexiePkg from 'dexie';
import { DatabaseSync } from 'node:sqlite';
import { createEngine, rpcHandlers } from 'granth-engine';
import { serveInWorker } from 'opfs-leader/worker';
import { Granth } from 'granthdb';

const Dexie = DexiePkg.default ?? DexiePkg;

const A = (db) => ({
  all: (s, p = []) => db.prepare(s).all(...p).map((r) => ({ ...r })),
  exec: (s) => db.exec(s),
  run: (s, p = []) => {
    const r = db.prepare(s).run(...p);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  },
  createFunction: (n, f) => db.function(n, f),
});

function fakeWorker() {
  const engine = createEngine(A(new DatabaseSync(':memory:')));
  const L = { message: [], error: [] };
  const scope = { addEventListener: (t, f) => (scope._r = f), postMessage: (m) => L.message.forEach((f) => f({ data: m })) };
  serveInWorker(rpcHandlers(() => engine), { scope });
  return { addEventListener: (t, f) => L[t]?.push(f), postMessage: (m) => scope._r({ data: m }), terminate() {} };
}

function makeLocks() {
  const st = new Map();
  const g = (n) => { if (!st.has(n)) st.set(n, { r: 0, w: false, q: [] }); return st.get(n); };
  function pump(n) {
    const s = g(n);
    while (s.q.length) {
      const h = s.q[0];
      const ok = h.mode === 'exclusive' ? !s.w && s.r === 0 : !s.w;
      if (!ok) return;
      s.q.shift();
      if (h.mode === 'exclusive') s.w = true; else s.r++;
      h.grant();
    }
  }
  return {
    request(name, o, f) {
      const fn = typeof o === 'function' ? o : f;
      const mode = typeof o === 'function' ? 'exclusive' : (o?.mode ?? 'exclusive');
      const s = g(name);
      return new Promise((res, rej) => {
        s.q.push({ mode, grant: async () => {
          try { res(await fn()); } catch (e) { rej(e); }
          finally { if (mode === 'exclusive') s.w = false; else s.r--; pump(name); }
        } });
        pump(name);
      });
    },
  };
}

/**
 * Stable serialization. `undefined` inside an array and a MISSING property are
 * different answers, and JSON.stringify erases both — which is how a wrong
 * result can look identical to a right one.
 */
function show(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[${v.map(show).join(',')}]`;
  if (v instanceof Map) return `Map{${[...v].map(([k, x]) => `${show(k)}=>${show(x)}`).join(',')}}`;
  if (v instanceof Set) return `Set{${[...v].map(show).join(',')}}`;
  if (v instanceof Date) return `Date(${v.toISOString()})`;
  if (typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${k}:${show(v[k])}`).join(',')}}`;
  }
  return typeof v === 'string' ? JSON.stringify(v) : String(v);
}

/** Errors are part of the answer: Dexie throwing where we return a row IS the bug. */
const asError = (e) => `ERROR(${e?.name === 'Error' ? '' : e?.name ?? ''}${String(e?.message ?? e).slice(0, 60)})`;

let seq = 0;
async function runDexie(schema, seed, fn) {
  const db = new Dexie(`parity${seq++}`);
  db.version(1).stores(schema);
  const table = db.table(Object.keys(schema)[0]);
  try {
    if (seed?.length) await table.bulkAdd(seed.map((d) => ({ ...d })));
    return show(await fn(table, db));
  } catch (e) { return asError(e); }
  finally { db.close(); }
}

async function runGranth(schema, seed, fn) {
  const db = new Granth(`parity${seq++}`, { worker: fakeWorker, locks: makeLocks() });
  db.version(1).stores(schema);
  const table = db.table(Object.keys(schema)[0]);
  try {
    if (seed?.length) await table.bulkAdd(seed.map((d) => ({ ...d })));
    return show(await fn(table, db));
  } catch (e) { return asError(e); }
  finally { await db.close?.(); }
}

const results = [];
async function parity(name, { schema, seed, run, allow }) {
  const [d, g] = [await runDexie(schema, seed, run), await runGranth(schema, seed, run)];
  results.push({ name, dexie: d, granth: g, ok: d === g, allow });
}

// ------------------------------------------------------------------ the cases

const NUM_PK = { t: '++id, name, age, *tags, [name+age]' };
const ABC = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];

// 1 — a string key against an INTEGER primary key. The delete is data loss.
await parity('get(string) on an integer key', {
  schema: NUM_PK, seed: ABC,
  run: async (t) => t.get('2'),
});
await parity('delete(string) on an integer key does not destroy a row', {
  schema: NUM_PK, seed: ABC,
  run: async (t) => { await t.delete('2'); return (await t.toArray()).map((r) => r.name); },
});
await parity('update(string) on an integer key changes nothing', {
  schema: NUM_PK, seed: ABC,
  run: async (t) => { const n = await t.update('2', { name: 'X' }); return [n, (await t.toArray()).map((r) => r.name)]; },
});
await parity('bulkGet agrees with get on a string key', {
  schema: NUM_PK, seed: ABC,
  run: async (t) => [await t.get('2'), (await t.bulkGet(['2']))[0]],
});

// 2 — index membership. A record whose key is absent or null is not IN the index.
const SPARSE = [{ name: 'zoe' }, { name: 'adam' }, {}, { name: null }, { name: 'carl' }];
const names = (rows) => rows.map((r) => r.name ?? null);
await parity('notEqual omits absent and null keys', {
  schema: NUM_PK, seed: SPARSE,
  run: async (t) => names(await t.where('name').notEqual('zoe').toArray()).sort(),
});
await parity('noneOf([]) omits absent and null keys', {
  schema: NUM_PK, seed: SPARSE,
  run: async (t) => names(await t.where('name').noneOf([]).toArray()).sort(),
});
await parity('noneOf([v]) omits absent and null keys', {
  schema: NUM_PK, seed: SPARSE,
  run: async (t) => names(await t.where('name').noneOf(['zoe']).toArray()).sort(),
});
await parity('orderBy omits absent and null keys', {
  schema: NUM_PK, seed: SPARSE,
  run: async (t) => names(await t.orderBy('name').toArray()),
});
await parity("startsWith('') omits absent and null keys", {
  schema: NUM_PK, seed: SPARSE,
  run: async (t) => names(await t.where('name').startsWith('').toArray()).sort(),
});

// 3 — iteration order follows the BOUND index, not the primary key.
const AGES = [
  { name: 'a', age: 30 }, { name: 'b', age: 10 }, { name: 'c', age: 20 },
  { name: 'd', age: 40 }, { name: 'e', age: 25 },
];
await parity('where(...).reverse() reverses the bound index', {
  schema: NUM_PK, seed: AGES,
  run: async (t) => (await t.where('age').above(15).reverse().toArray()).map((r) => r.name),
});
await parity('where(...) forward order follows the bound index', {
  schema: NUM_PK, seed: AGES,
  run: async (t) => (await t.where('age').above(15).toArray()).map((r) => r.name),
});
await parity('paging a reversed range returns the same ROWS', {
  schema: NUM_PK, seed: AGES,
  run: async (t) => (await t.where('age').above(15).reverse().offset(1).limit(2).toArray()).map((r) => r.name),
});
await parity('orderBy(...).keys() is in index order', {
  schema: NUM_PK, seed: AGES,
  run: async (t) => t.orderBy('age').keys(),
});
await parity('where(...).keys() is in index order', {
  schema: NUM_PK, seed: AGES,
  run: async (t) => t.where('age').above(15).keys(),
});

// 4 — case folding is Unicode, not ASCII.
const CASE = [{ name: 'ÉCOLE' }, { name: 'école' }, { name: 'ΣΊΣΥΦΟΣ' }, { name: 'STRASSE' }, { name: 'Ångström' }];
await parity('equalsIgnoreCase folds non-ASCII', {
  schema: NUM_PK, seed: CASE,
  run: async (t) => (await t.where('name').equalsIgnoreCase('École').toArray()).map((r) => r.name).sort(),
});
await parity('startsWithIgnoreCase folds non-ASCII', {
  schema: NUM_PK, seed: CASE,
  run: async (t) => (await t.where('name').startsWithIgnoreCase('ång').toArray()).map((r) => r.name).sort(),
});
await parity('anyOfIgnoreCase folds non-ASCII', {
  schema: NUM_PK, seed: CASE,
  run: async (t) => (await t.where('name').anyOfIgnoreCase(['ΣΊΣΥΦΟΣ']).toArray()).map((r) => r.name).sort(),
});

// 6 — multiEntry key accessors report the MATCHED elements, not the row's others.
const TAGGED = [{ name: 'x', tags: ['a', 'b'] }, { name: 'y', tags: ['a', 'c'] }, { name: 'z', tags: ['d'] }];
await parity('multiEntry uniqueKeys returns only matching elements', {
  schema: NUM_PK, seed: TAGGED,
  run: async (t) => t.where('tags').equals('a').uniqueKeys(),
});
await parity('multiEntry keys returns only matching elements', {
  schema: NUM_PK, seed: TAGGED,
  run: async (t) => t.where('tags').equals('a').keys(),
});

// 7 — sortBy honours reverse().
await parity('sortBy honours reverse() on an indexed keyPath', {
  schema: NUM_PK, seed: AGES,
  run: async (t) => (await t.toCollection().reverse().sortBy('age')).map((r) => r.name),
});
await parity('sortBy honours reverse() on a non-indexed keyPath', {
  schema: NUM_PK, seed: AGES,
  run: async (t) => (await t.toCollection().reverse().sortBy('name')).map((r) => r.name),
});

// 8 — a compound key survives a client-side filter.
await parity('compound keys() is unchanged by attaching a filter', {
  schema: NUM_PK, seed: AGES,
  run: async (t) => [
    await t.where('[name+age]').equals(['a', 30]).keys(),
    await t.where('[name+age]').equals(['a', 30]).filter(() => true).keys(),
  ],
});

// 9 — notEqual on a compound index behaves like equals on the same index.
await parity('notEqual on a compound index', {
  schema: NUM_PK, seed: AGES,
  run: async (t) => (await t.where('[name+age]').notEqual(['a', 30]).toArray()).map((r) => r.name).sort(),
});

// 10 — limit() with values a paging expression can actually produce.
await parity('limit(-1) returns nothing', {
  schema: NUM_PK, seed: ABC,
  run: async (t) => (await t.toCollection().limit(-1).toArray()).map((r) => r.name),
});
await parity('limit(0) returns nothing', {
  schema: NUM_PK, seed: ABC,
  run: async (t) => (await t.toCollection().limit(0).toArray()).map((r) => r.name),
});
await parity('limit(1.7) is not a SQL error', {
  schema: NUM_PK, seed: ABC,
  run: async (t) => (await t.toCollection().limit(1.7).toArray()).map((r) => r.name),
});

// 11 — bulkAdd inside a transaction.
await parity('bulkAdd inside a transaction', {
  schema: NUM_PK, seed: [],
  run: async (t, db) => {
    await db.transaction('rw', t, async () => { await t.bulkAdd([{ name: 'p' }, { name: 'q' }]); });
    return (await t.toArray()).map((r) => r.name);
  },
});
await parity('bulkPut inside a transaction', {
  schema: NUM_PK, seed: [],
  run: async (t, db) => {
    await db.transaction('rw', t, async () => { await t.bulkPut([{ name: 'p' }, { name: 'q' }]); });
    return (await t.toArray()).map((r) => r.name);
  },
});

// 12 — a lone low surrogate is a code point of its own, not half a pair.
await parity('startsWith with a lone low surrogate', {
  schema: NUM_PK, seed: [{ name: 'a\uDC00z' }, { name: 'b' }],
  run: async (t) => (await t.where('name').startsWith('a\uDC00').toArray()).map((r) => r.name),
  // The value round-trips exactly; only MATCHING it is impossible. json_extract
  // decodes our JSON escape to WTF-8 (ED B0 80) while the driver binds the same
  // string as U+FFFD (EF BF BD), so the stored key sorts below its own lower
  // bound. Fails closed — no rows, never wrong rows. See codec.ts.
  allow: 'a lone surrogate has two incompatible encodings across the SQLite boundary',
});
await parity('startsWith with an astral character', {
  schema: NUM_PK, seed: [{ name: '𝔘nicode' }, { name: 'b' }],
  run: async (t) => (await t.where('name').startsWith('𝔘').toArray()).map((r) => r.name),
});

// 13 — the smaller disagreements.
await parity('update to undefined deletes the property', {
  schema: NUM_PK, seed: [{ name: 'a', age: 1 }],
  run: async (t) => { await t.update(1, { age: undefined }); const d = await t.get(1); return ['age' in d, d.age]; },
});
const BOTH_THROW = 'both reject the key; only the message text differs';
await parity('get(null) is rejected', { schema: NUM_PK, seed: ABC, allow: BOTH_THROW, run: async (t) => t.get(null) });
await parity('get({}) is rejected', { schema: NUM_PK, seed: ABC, allow: BOTH_THROW, run: async (t) => t.get({}) });
await parity('Collection.delete() with a filter counts rows actually deleted', {
  schema: NUM_PK, seed: ABC,
  run: async (t) => {
    const n = await t.toCollection().filter((r) => r.name === 'b').delete();
    return [n, (await t.toArray()).map((r) => r.name)];
  },
});

// ---- and the things that must NOT regress while the above are fixed --------
await parity('equals still matches', {
  schema: NUM_PK, seed: AGES, run: async (t) => (await t.where('age').equals(20).toArray()).map((r) => r.name),
});
await parity('between still matches', {
  schema: NUM_PK, seed: AGES,
  run: async (t) => (await t.where('age').between(10, 30, true, true).toArray()).map((r) => r.name),
});
await parity('anyOf still matches', {
  schema: NUM_PK, seed: AGES,
  run: async (t) => (await t.where('age').anyOf([10, 40]).toArray()).map((r) => r.name).sort(),
});
await parity('compound equals still matches', {
  schema: NUM_PK, seed: AGES, run: async (t) => (await t.where('[name+age]').equals(['c', 20]).toArray()).map((r) => r.name),
});
await parity('multiEntry equals still matches', {
  schema: NUM_PK, seed: TAGGED,
  run: async (t) => (await t.where('tags').equals('a').toArray()).map((r) => r.name).sort(),
});
await parity('string primary keys are untouched', {
  schema: { t: 'code, name' }, seed: [{ code: 'x', name: 'a' }, { code: 'y', name: 'b' }],
  run: async (t) => [await t.get('x'), await t.get('nope')],
});
await parity('offset/limit on the primary key', {
  schema: NUM_PK, seed: AGES, run: async (t) => (await t.toCollection().offset(1).limit(2).toArray()).map((r) => r.name),
});
await parity('reverse() on the primary key', {
  schema: NUM_PK, seed: AGES, run: async (t) => (await t.toCollection().reverse().toArray()).map((r) => r.name),
});
await parity('count with a range', {
  schema: NUM_PK, seed: SPARSE, run: async (t) => t.where('name').notEqual('zoe').count(),
});
await parity('Date values round-trip', {
  schema: { t: '++id, when' }, seed: [{ when: new Date('2020-01-02T03:04:05Z') }],
  run: async (t) => (await t.get(1)).when,
});

// Guards for the ways THESE fixes could go wrong ---------------------------
const SORTBY_UNDEF =
  "Dexie's sortBy comparator returns 0 whenever either side is undefined, so it is non-transitive and its output depends on the sort algorithm's internals — verified: the same code leaves [3,undefined,1] UNSORTED and sorts [z,undefined,a] with undefined first. granth sorts transitively, undefined last. Replicating non-transitivity is not possible in general.";
// orderBy now drops rows with no key. sortBy must NOT: Dexie sorts client-side
// and keeps them (undefined last), and routing it through the index was exactly
// the shortcut that gave one method two behaviours.
await parity('sortBy keeps rows with no key', {
  schema: NUM_PK, seed: [{ name: 'a', age: 3 }, { name: 'b' }, { name: 'c', age: 1 }],
  run: async (t) => (await t.toCollection().sortBy('age')).map((r) => r.name),
  allow: SORTBY_UNDEF,
});
await parity('sortBy keeps rows with no key on a non-indexed path', {
  schema: NUM_PK, seed: [{ name: 'a', note: 'z' }, { name: 'b' }, { name: 'c', note: 'a' }],
  run: async (t) => (await t.toCollection().sortBy('note')).map((r) => r.name),
  allow: SORTBY_UNDEF,
});
await parity('orderBy then reverse', {
  schema: NUM_PK, seed: AGES,
  run: async (t) => (await t.orderBy('age').reverse().toArray()).map((r) => r.name),
});
await parity('orderBy with offset and limit', {
  schema: NUM_PK, seed: AGES,
  run: async (t) => (await t.orderBy('age').offset(1).limit(2).toArray()).map((r) => r.name),
});
// A client-side .filter() must not change the ORDER the server-side path gives.
await parity('a filter does not change iteration order', {
  schema: NUM_PK, seed: AGES,
  run: async (t) => (await t.where('age').above(15).filter(() => true).toArray()).map((r) => r.name),
});
await parity('or() across two indexes', {
  schema: NUM_PK, seed: AGES,
  run: async (t) => (await t.where('age').equals(10).or('name').equals('d').toArray()).map((r) => r.name).sort(),
});
await parity('notEqual on the primary key', {
  schema: NUM_PK, seed: ABC, run: async (t) => (await t.where('id').notEqual(2).toArray()).map((r) => r.name),
});
await parity('bulkAdd returns the LAST key', {
  schema: NUM_PK, seed: [], run: async (t) => t.bulkAdd([{ name: 'p' }, { name: 'q' }]),
});
await parity('bulkAdd({allKeys}) returns every key', {
  schema: NUM_PK, seed: [], run: async (t) => t.bulkAdd([{ name: 'p' }, { name: 'q' }], { allKeys: true }),
});
await parity('bulkPut returns the LAST key', {
  schema: NUM_PK, seed: [], run: async (t) => t.bulkPut([{ name: 'p' }, { name: 'q' }]),
});
await parity('put with an explicit string key on a string primary key', {
  schema: { t: 'code, name' }, seed: [{ code: 'x', name: 'a' }],
  run: async (t) => { await t.put({ code: 'x', name: 'b' }); return (await t.toArray()).map((r) => r.name); },
});
await parity('modify sets a value to null', {
  schema: NUM_PK, seed: [{ name: 'a', age: 1 }],
  run: async (t) => { await t.toCollection().modify({ age: null }); const d = await t.get(1); return ['age' in d, d.age]; },
});
await parity('startsWith still narrows', {
  schema: NUM_PK, seed: [{ name: 'apple' }, { name: 'apricot' }, { name: 'banana' }],
  run: async (t) => (await t.where('name').startsWith('ap').toArray()).map((r) => r.name),
});
await parity('equalsIgnoreCase still matches plain ASCII', {
  schema: NUM_PK, seed: [{ name: 'Bob' }, { name: 'bob' }, { name: 'BOB' }, { name: 'rob' }],
  run: async (t) => (await t.where('name').equalsIgnoreCase('bob').toArray()).map((r) => r.name).sort(),
});

// ------------------------------------------------------------------- report

// An `allow` that no longer differs is dead weight that would hide the next
// regression on that line, so a stale one fails the run too.
const stale = results.filter((r) => r.ok && r.allow);
const fails = [...results.filter((r) => !r.ok && !r.allow), ...stale];
const allowed = results.filter((r) => !r.ok && r.allow);
for (const r of results) {
  if (r.ok) { console.log(`${r.allow ? 'STALE-ALLOW' : 'PASS '} ${r.name}`); continue; }
  const tag = r.allow ? 'ALLOW' : 'FAIL ';
  console.log(`${tag} ${r.name}`);
  console.log(`        dexie : ${r.dexie}`);
  console.log(`        granth: ${r.granth}`);
  if (r.allow) console.log(`        why   : ${r.allow}`);
}
console.log(
  `\n${results.length - fails.length - allowed.length}/${results.length} match Dexie` +
    (allowed.length ? `, ${allowed.length} allowed to differ` : '') +
    (fails.length ? `, ${fails.length} DISAGREE` : '')
);
process.exit(fails.length ? 1 : 0);
