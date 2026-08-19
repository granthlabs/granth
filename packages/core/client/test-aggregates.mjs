/**
 * sum / avg / min / max, against real SQLite.
 *
 * These exist because the only way to total a column used to be `toArray()` and
 * add up in JS, which ships every matching row across postMessage to produce one
 * number. The Ledger showcase was moving ~14,000 rows per render to display four
 * totals — the aggregation the database was there to do, done on the wrong side
 * of the worker.
 *
 * The interesting cases are not "does sum add up". They are the ones where SQL
 * and JS disagree about what an aggregate MEANS: no rows, absent fields, nulls,
 * non-numeric values, and a client-side .filter() that forces the JS path — the
 * two paths have to give the same answer or the optimisation is a behaviour
 * change wearing a performance costume.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createEngine, rpcHandlers } from 'granth-engine';
import { inlineRuntime } from 'granth-runtime-inline';
import { Granth } from 'granthdb';

const db = new DatabaseSync(':memory:');
const adapter = {
  all: (s, p = []) => db.prepare(s).all(...p).map((r) => ({ ...r })),
  exec: (s) => db.exec(s),
  run: (s, p = []) => {
    const r = db.prepare(s).run(...p);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  },
  createFunction: (n, f) => db.function(n, { deterministic: true }, f),
};
const engine = createEngine(adapter);

const g = new Granth('agg', {
  runtime: inlineRuntime({ createHandlers: async () => rpcHandlers(() => engine) }),
});
// `amount` is indexed, `bonus` deliberately is NOT — an aggregate has to work on
// both, and they take different routes to a value (generated column vs
// json_extract).
g.version(1).stores({ t: '++id, account, amount' });
await g.open();

await g.t.bulkAdd([
  { account: 'a', amount: 100, bonus: 5, tag: 'x' },
  { account: 'a', amount: 250, bonus: 0, tag: 'y' },
  { account: 'b', amount: -40, tag: 'x' },          // bonus ABSENT
  { account: 'b', amount: 60, bonus: null, tag: 'y' }, // bonus NULL
  { account: 'c', amount: 1000, bonus: 'nope', tag: 'z' }, // bonus NON-NUMERIC
]);

let n = 0;
const eq = (name, actual, expected) => { assert.deepEqual(actual, expected, name); n++; };

// ---- the basics, in SQL
eq('sum over the whole table', await g.t.sum('amount'), 1370);
eq('sum over a filtered set', await g.t.where('account').equals('a').sum('amount'), 350);
eq('min', await g.t.min('amount'), -40);
eq('max', await g.t.max('amount'), 1000);
eq('avg', await g.t.avg('amount'), 1370 / 5);

// ---- an UNINDEXED field must work too
eq('sum of an unindexed field', await g.t.sum('bonus'), 5);

// ---- SQL semantics that a naive JS version gets wrong
eq('sum of no rows is null, not 0', await g.t.where('account').equals('zzz').sum('amount'), null);
eq('min of no rows is null', await g.t.where('account').equals('zzz').min('amount'), null);
eq('count of no rows is still 0', await g.t.where('account').equals('zzz').count(), 0);

// ---- the client-side path must agree with the SQL path
// A .filter() cannot cross into the worker, so this is the JS branch. Same
// question, same answer, or the fast path is a behaviour change in disguise.
const jsSum = await g.t.filter((r) => r.account === 'a').sum('amount');
eq('a client-side filter sums the same', jsSum, 350);
const jsEmpty = await g.t.filter(() => false).sum('amount');
eq('client-side sum of no rows is also null', jsEmpty, null);
const jsMax = await g.t.filter((r) => r.amount > 0).max('amount');
eq('client-side max agrees', jsMax, 1000);

// ---- rows missing the field contribute nothing, on both paths
eq('unindexed sum ignores absent/null/non-numeric', await g.t.sum('bonus'), 5);
eq('client-side agrees about absent/null/non-numeric',
  await g.t.filter(() => true).sum('bonus'), 5);

// ---- a bad call fails loudly rather than returning something plausible
await assert.rejects(() => g.t.sum(), /needs a field name/, 'sum() with no field must throw');
await assert.rejects(() => g.t.sum(''), /needs a field name/, 'sum("") must throw');
n += 2;

// ---- aggregates respect limit, because the collection said so
eq('sum honours limit', await g.t.orderBy('amount').limit(2).sum('amount'), -40 + 60);

await g.close();
console.log(`aggregates: ${n} checks (SQL and client-side paths agree, empty sets are null)`);
