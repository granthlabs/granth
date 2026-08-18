/**
 * End-to-end Dexie → granth migration, checked DIFFERENTIALLY.
 *
 * The existing compat check migrates two rows across two tables — a smoke test.
 * A real app has explicit string keys as well as auto keys, unique indexes,
 * compound indexes, multiEntry arrays, Dates, nulls, nested objects and enough
 * rows that a chunking bug shows up. This seeds that, migrates it, then runs the
 * SAME queries against the original Dexie database and the migrated granth one
 * and diffs the answers — the technique that found the defects a green suite had
 * missed. An assertion I write myself can only check what I thought of; Dexie
 * answering the same question cannot be fooled that way.
 */
import Dexie from 'dexie';
import { Granth } from 'granthdb';
import { inspectIndexedDB, suggestSchema, importFromIndexedDB } from 'granth-migrate-idb';

const results = [];
const log = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  const li = document.createElement('li');
  li.className = ok ? 'ok' : 'fail';
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = ok ? 'PASS' : 'FAIL';
  const text = document.createElement('span');
  text.textContent = `${name}${detail ? ' — ' + detail : ''}`;
  li.append(tag, text);
  document.getElementById('out').appendChild(li);
};
const check = async (name, fn) => {
  try { const d = await fn(); log(name, true, typeof d === 'string' ? d : ''); }
  catch (err) { log(name, false, err?.message ?? String(err)); }
};

const LEGACY = 'legacy-shop';
const ROLES = ['admin', 'editor', 'viewer', 'billing'];
const rng = (seed) => { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); };

/** Deterministic, so a failure is reproducible rather than a one-off. */
function seedData() {
  const r = rng(4242);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const users = [];
  for (let i = 0; i < 1200; i++) {
    users.push({
      email: `user${i}@example.com`,                 // &unique
      name: `Person ${String.fromCharCode(65 + (i % 26))}${i}`,
      age: 18 + Math.floor(r() * 60),
      roles: [...new Set([pick(ROLES), pick(ROLES)])],
      joined: new Date(Date.UTC(2024, 0, 1) + Math.floor(r() * 700) * 86400_000),
      profile: { city: pick(['London', 'Lisbon', 'Boston', 'Kyoto']), verified: r() > 0.5 },
      nickname: r() > 0.8 ? null : `nick${i}`,       // nulls must survive
      score: r() > 0.9 ? 0 : Math.round(r() * 1000), // 0 must not be treated as absent
    });
  }
  const orders = [];
  for (let i = 0; i < 1500; i++) {
    orders.push({
      ref: `ORD-${String(i).padStart(5, '0')}`,      // EXPLICIT string primary key
      userId: 1 + Math.floor(r() * 1200),
      placed: new Date(Date.UTC(2025, 0, 1) + Math.floor(r() * 400) * 86400_000),
      total: Math.round(r() * 50000) / 100,
      items: Math.ceil(r() * 6),
    });
  }
  return { users, orders };
}

/** The queries both databases must answer identically. */
function questions(db) {
  return {
    'users.count': () => db.users.count(),
    'orders.count': () => db.orders.count(),
    'get by auto key': () => db.users.get(7),
    'get by string key': () => db.orders.get('ORD-00042'),
    'unique index lookup': () => db.users.where('email').equals('user500@example.com').first(),
    'index equals': () => db.users.where('age').equals(30).count(),
    'range': () => db.users.where('age').between(25, 35, true, true).count(),
    'multiEntry': () => db.users.where('roles').equals('admin').count(),
    // Derived from a row that actually exists. Hard-coding a tuple gave 0 on
    // BOTH sides, and 0 === 0 is agreement about nothing — the same
    // can't-fail shape this project keeps finding in its own tests.
    'compound': async () => {
      const u = await db.users.get(500);
      return db.users.where('[name+age]').equals([u.name, u.age]).count();
    },
    'orderBy + limit': () => db.users.orderBy('age').limit(5).toArray().then((r) => r.map((u) => u.email)),
    'orderBy desc': () => db.users.orderBy('age').reverse().limit(5).toArray().then((r) => r.map((u) => u.email)),
    'startsWith': () => db.users.where('name').startsWith('Person A').count(),
    'anyOf': () => db.users.where('age').anyOf([20, 40, 60]).count(),
    'orders by user': () => db.orders.where('userId').equals(42).count(),
    'orders range': () => db.orders.where('total').above(400).count(),
    'a whole row, deeply': () => db.users.get(123),
    'nulls survive': () => db.users.filter((u) => u.nickname === null).count(),
    'zero is not absent': () => db.users.filter((u) => u.score === 0).count(),
  };
}

/** Stable rendering: undefined vs missing vs null are different answers. */
const show = (v) =>
  v === undefined ? 'undefined'
    : v === null ? 'null'
    : Array.isArray(v) ? `[${v.map(show).join(',')}]`
    : v instanceof Date ? `Date(${v.toISOString()})`
    : typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${k}:${show(v[k])}`).join(',')}}`
    : typeof v === 'string' ? JSON.stringify(v) : String(v);

async function run() {
  let legacy, target, derived;

  await check('seed a realistic Dexie app (1,200 users + 1,500 orders)', async () => {
    await Dexie.delete(LEGACY);
    legacy = new Dexie(LEGACY);
    legacy.version(1).stores({
      users: '++id, &email, name, age, joined, *roles, [name+age]',
      orders: 'ref, userId, placed, total',
    });
    await legacy.open();
    const { users, orders } = seedData();
    await legacy.users.bulkAdd(users);
    await legacy.orders.bulkAdd(orders);
    return `${await legacy.users.count()} users, ${await legacy.orders.count()} orders`;
  });

  await check('inspectIndexedDB sees every index, including the awkward ones', async () => {
    const info = await inspectIndexedDB(LEGACY);
    const u = info.stores.find((s) => s.name === 'users');
    const o = info.stores.find((s) => s.name === 'orders');
    if (!u.autoIncrement) throw new Error('users should be auto-increment');
    if (o.autoIncrement) throw new Error('orders has an explicit key, not auto-increment');
    const names = u.indexes.map((i) => i.name);
    for (const want of ['email', 'name', 'age', 'roles', '[name+age]']) {
      if (!names.includes(want)) throw new Error(`missing index ${want} (saw ${names.join(', ')})`);
    }
    if (!u.indexes.find((i) => i.name === 'email').unique) throw new Error('unique flag lost');
    if (!u.indexes.find((i) => i.name === 'roles').multiEntry) throw new Error('multiEntry flag lost');
    return `${u.count} + ${o.count} rows, ${names.length} indexes`;
  });

  await check('suggestSchema derives a usable stores() spec', async () => {
    derived = await suggestSchema(LEGACY);
    if (!/\+\+id/.test(derived.users)) throw new Error(`auto key lost: ${derived.users}`);
    if (!/&email/.test(derived.users)) throw new Error(`unique lost: ${derived.users}`);
    if (!/\*roles/.test(derived.users)) throw new Error(`multiEntry lost: ${derived.users}`);
    if (!/\[name\+age\]/.test(derived.users)) throw new Error(`compound lost: ${derived.users}`);
    if (/\+\+/.test(derived.orders)) throw new Error(`orders must NOT be auto: ${derived.orders}`);
    return `users: ${derived.users}`;
  });

  await check('importFromIndexedDB moves the whole application', async () => {
    target = new Granth('migrated-shop', {
      worker: () => new Worker(new URL('./migrated.worker.js', import.meta.url), { type: 'module' }),
    });
    target.version(1).stores(derived);
    await target.open();
    await target.users.clear();
    await target.orders.clear();
    const t0 = performance.now();
    const counts = await importFromIndexedDB(target, { from: LEGACY });
    const ms = performance.now() - t0;
    if (counts.users !== 1200 || counts.orders !== 1500) throw new Error(JSON.stringify(counts));
    return `${counts.users + counts.orders} rows in ${ms.toFixed(0)} ms`;
  });

  // The differential pass: the same question to both databases.
  const asked = questions(legacy);
  const answered = questions(target);
  let diffs = 0;
  for (const name of Object.keys(asked)) {
    // eslint-disable-next-line no-await-in-loop
    await check(`same answer: ${name}`, async () => {
      const [a, b] = await Promise.all([
        asked[name]().then(show, (e) => `ERROR(${e.name})`),
        answered[name]().then(show, (e) => `ERROR(${e.name})`),
      ]);
      if (a !== b) { diffs++; throw new Error(`dexie ${a.slice(0, 90)} · granth ${b.slice(0, 90)}`); }
      return a.length > 60 ? `${a.slice(0, 60)}…` : a;
    });
  }

  await check('every row survived, compared deeply', async () => {
    const [a, b] = await Promise.all([legacy.users.orderBy('id').toArray(), target.users.orderBy('id').toArray()]);
    if (a.length !== b.length) throw new Error(`${a.length} vs ${b.length} rows`);
    for (let i = 0; i < a.length; i++) {
      if (show(a[i]) !== show(b[i])) throw new Error(`row ${i}: ${show(a[i]).slice(0, 100)} vs ${show(b[i]).slice(0, 100)}`);
    }
    return `${a.length} rows identical, field for field`;
  });

  await check('explicit string keys survived exactly', async () => {
    const [a, b] = await Promise.all([legacy.orders.orderBy('ref').toArray(), target.orders.orderBy('ref').toArray()]);
    if (a.length !== b.length) throw new Error(`${a.length} vs ${b.length}`);
    for (let i = 0; i < a.length; i++) if (show(a[i]) !== show(b[i])) throw new Error(`order ${i} differs`);
    return `${a.length} orders identical`;
  });

  await check('re-importing overwrites rather than duplicating', async () => {
    await importFromIndexedDB(target, { from: LEGACY });
    const n = await target.users.count();
    if (n !== 1200) throw new Error(`${n} users after a second import`);
    return 'still 1,200 users';
  });

  await check('writes work normally after the migration', async () => {
    const id = await target.users.add({ email: 'new@example.com', name: 'New Person', age: 44, roles: ['admin'], score: 1 });
    const back = await target.users.get(id);
    if (back?.email !== 'new@example.com') throw new Error('new row not readable');
    if ((await target.users.where('roles').equals('admin').count()) < 2) throw new Error('multiEntry index not maintained for new rows');
    await target.users.delete(id);
    return 'insert, index, delete all fine on the migrated database';
  });

  legacy.close();
  await target.close();

  const failed = results.filter((r) => !r.ok);
  window.__RESULTS__ = { total: results.length, failed: failed.length, diffs, results };
  const el = document.getElementById('summary');
  el.textContent = failed.length ? `${failed.length} of ${results.length} FAILED` : `ALL ${results.length} PASSED`;
  el.className = failed.length ? 'fail' : 'ok';
}

run().catch((err) => {
  log('harness', false, err?.stack ?? String(err));
  window.__RESULTS__ = { fatal: String(err?.message ?? err), failed: 1 };
  document.getElementById('summary').textContent = 'FATAL';
});
