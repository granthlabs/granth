// Proves the no-Worker path. Node has no global Worker, so if this passes here
// it genuinely ran without one — the same path a strict-CSP page or an SSR
// render takes.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Granth } from 'granth';
import { inlineRuntime } from '@granth/runtime-inline';
import { createEngine, rpcHandlers } from '@granth/engine';

assert.equal(typeof globalThis.Worker, 'undefined', 'this test is only meaningful without a Worker');

const adapter = (db) => ({
  all: (s, p = []) => db.prepare(s).all(...p).map((r) => ({ ...r })),
  exec: (s) => db.exec(s),
  run: (s, p = []) => {
    const r = db.prepare(s).run(...p);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  },
});

const engine = createEngine(adapter(new DatabaseSync(':memory:')));
const db = new Granth('inline', {
  runtime: inlineRuntime({ createHandlers: async () => rpcHandlers(() => engine) }),
});
db.version(1).stores({ friends: '++id, name, age, when, *tags' });

assert.equal(await db.runtimeKind(), 'inline', 'must report the inline runtime');

// the full surface has to behave identically to the worker path
const id = await db.friends.add({ name: 'ada', age: 36, tags: ['math'], when: new Date('2020-01-01') });
assert.equal((await db.friends.get(id)).name, 'ada');
assert.ok((await db.friends.get(id)).when instanceof Date, 'the codec must apply on the inline path too');
await db.friends.bulkAdd([{ name: 'bob', age: 25, tags: ['eng'] }, { name: 'cy', age: 41, tags: ['math'] }]);
assert.deepEqual((await db.friends.where('age').above(30).toArray()).map((f) => f.name).sort(), ['ada', 'cy']);
assert.deepEqual((await db.friends.where('tags').equals('math').toArray()).map((f) => f.name).sort(), ['ada', 'cy']);
assert.deepEqual((await db.friends.where('age').above(0).orderBy('name').toArray()).map((f) => f.name), ['ada', 'bob', 'cy']);

// transactions, including the interactive form that needs a lock
await db.transaction((tx) => { tx.friends.add({ name: 'eve', age: 22, tags: [] }); });
assert.equal(await db.friends.count(), 4);
await db.transaction('rw', db.friends, async () => {
  const n = await db.friends.count();
  await db.friends.add({ name: `tx-${n}`, age: 7, tags: [] });
});
assert.equal(await db.friends.count(), 5);
await assert.rejects(
  db.transaction('rw', db.friends, async () => { await db.friends.add({ name: 'doomed', age: 8, tags: [] }); throw new Error('boom'); }),
  /boom/
);
assert.equal(await db.friends.where('name').equals('doomed').count(), 0, 'rollback must work without a Worker');

// liveQuery
const seen = [];
const sub = db.liveQuery(() => db.friends.where('age').above(30).toArray()).subscribe((r) => seen.push(r.length));
await new Promise((r) => setTimeout(r, 30));
assert.equal(seen.length, 1, 'initial emit');
await db.friends.add({ name: 'fay', age: 50, tags: [] });
await new Promise((r) => setTimeout(r, 30));
assert.equal(seen.length, 2, 'emit on change');
sub.unsubscribe();

// plugin add / remove
const calls = [];
const handle = db.use({
  name: 'audit',
  setup(ctx) {
    ctx.before((c) => { calls.push(c.op); });
  },
});
assert.deepEqual(db.plugins, ['audit']);
await db.friends.count();
assert.ok(calls.length > 0, 'the before hook must fire');
await handle.dispose();
assert.deepEqual(db.plugins, [], 'a disposed plugin must be removed');
const after = calls.length;
await db.friends.count();
assert.equal(calls.length, after, 'a disposed hook must stop firing');

await db.close();
console.log('inline runtime (no Worker): all assertions passed');
process.exit(0);
