// Browser verification against REAL sqlite-wasm + OPFS.
// Node's selfcheck proves the SQL; this proves the platform layer:
// opfs-sahpool without COOP/COEP, the dedicated worker, Web Locks election,
// and — the thing only a browser can show — durability across a reload.

import { Granth } from 'granth';

const results = [];
const log = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  const li = document.createElement('li');
  li.className = ok ? 'ok' : 'fail';
  li.textContent = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`;
  document.getElementById('out').appendChild(li);
  console[ok ? 'log' : 'error'](`${ok ? 'PASS' : 'FAIL'} ${name}`, detail);
};

async function check(name, fn) {
  try {
    await fn();
    log(name, true);
  } catch (err) {
    log(name, false, err?.message ?? String(err));
  }
}

const eq = (a, b, msg = '') => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg} expected ${B}, got ${A}`);
};

const V1 = { friends: '++id, name, age, flag, when, *tags, [name+age]', notes: '++id, owner' };
const V2 = { friends: '++id, name, age, city, flag, when, *tags, [name+age]' };

/** @param {1|2} upto  open the database declaring versions up to `upto` */
function makeDb(upto = 2) {
  const db = new Granth('playground', {
    worker: () => new Worker(new URL('./db.worker.js', import.meta.url), { type: 'module' }),
  });
  db.version(1).stores(V1);
  if (upto >= 2) db.version(2).stores(V2);
  return db;
}

const PHASE = new URLSearchParams(location.search).get('phase') ?? 'fresh';

async function run() {
  document.getElementById('phase').textContent = PHASE;

  await check('crossOriginIsolated is FALSE (no COOP/COEP needed)', () => {
    if (self.crossOriginIsolated) throw new Error('page IS cross-origin isolated — the test is not proving the sahpool claim');
  });

  await check('OPFS is available', async () => {
    const root = await navigator.storage.getDirectory();
    if (!root) throw new Error('no OPFS root');
  });

  let db, meta;

  if (PHASE === 'fresh') {
    await check('wipe any database left by a previous run', async () => {
      const old = makeDb(2);
      await old.open();
      await old.deleteDatabase();
      await old.close();
      await sleep(150);
    });

    await check('an old tab refuses to open a NEWER file (VersionError)', async () => {
      const seed = makeDb(2);
      await seed.open();
      await seed.close();
      await sleep(150);
      const stale = makeDb(1); // declares only v1 against a v2 file
      let threw = null;
      try { await stale.open(); } catch (err) { threw = err; }
      await stale.close();
      await sleep(150);
      if (!threw) throw new Error('a v1 client opened a v2 database');
      if (!/version/i.test(threw.message)) throw new Error(`wrong error: ${threw.message}`);
      const reset = makeDb(2);
      await reset.open();
      await reset.deleteDatabase();
      await reset.close();
      await sleep(150);
    });

    // Stage A: open at v1 ONLY and write data, so the v1 -> v2 migration below
    // has rows to upgrade. Migrating an empty table proves nothing.
    await check('open at v1 and seed data', async () => {
      const v1db = makeDb(1);
      const m = await v1db.open();
      if (m.version !== 1) throw new Error(`expected v1, got ${m.version}`);
      await v1db.friends.clear();
      await v1db.notes.clear();
      await v1db.friends.bulkAdd([{ name: 'legacy', age: 70, tags: [] }]);
      await v1db.close();
      await sleep(150); // let the old worker release the SAH pool
    });

    db = makeDb(2);
    await check('open() migrates v1 -> v2 on a real OPFS file', async () => {
      meta = await db.open();
      if (meta.version !== 2) throw new Error(`version ${meta.version}`);
      if (meta.migrated !== true) throw new Error('expected a migration to run');
      if (meta.from !== 1) throw new Error(`expected from=1, got ${meta.from}`);
    });

    await check('v2 upgrade handler backfilled EXISTING rows in the worker', async () => {
      const legacy = await db.friends.where('name').equals('legacy').first();
      if (!legacy) throw new Error('legacy row vanished across the migration');
      eq(legacy.city, 'unknown', 'upgrade must backfill rows written before the index existed:');
      eq(await db.friends.where('city').equals('unknown').count(), 1, 'new index must see pre-existing rows:');
    });

    await check('start the query suite from a clean table', async () => {
      await db.friends.clear();
      await db.notes.clear();
      eq(await db.friends.count(), 0);
    });

    await check('add / get / bulkAdd', async () => {
      const id = await db.friends.add({ name: 'ada', age: 36, tags: ['math'] });
      const got = await db.friends.get(id);
      eq(got.name, 'ada');
      eq(got.id, id, 'key must be injected on read:');
      await db.friends.bulkAdd([
        { name: 'bob', age: 25, tags: ['eng'] },
        { name: 'cy', age: 41, tags: ['math', 'eng'] },
        { name: 'dee', age: 25 },
      ]);
      eq(await db.friends.count(), 4);
    });

    await check('indexed queries', async () => {
      eq((await db.friends.where('age').above(30).toArray()).map((f) => f.name).sort(), ['ada', 'cy']);
      eq((await db.friends.where('name').startsWith('b').toArray()).map((f) => f.name), ['bob']);
      eq((await db.friends.where('age').between(25, 41, true, true).count()), 4);
      eq((await db.friends.where({ name: 'bob', age: 25 }).toArray()).map((f) => f.name), ['bob']);
    });

    await check('multiEntry index via trigger-maintained shadow table', async () => {
      eq((await db.friends.where('tags').equals('math').toArray()).map((f) => f.name).sort(), ['ada', 'cy']);
      eq((await db.friends.where('tags').equals('eng').toArray()).map((f) => f.name).sort(), ['bob', 'cy']);
    });

    await check('compound index', async () => {
      eq((await db.friends.where('[name+age]').equals(['bob', 25]).toArray()).map((f) => f.name), ['bob']);
    });

    await check('order / limit / offset / reverse', async () => {
      eq((await db.friends.orderBy('age').toArray()).map((f) => f.age), [25, 25, 36, 41]);
      eq((await db.friends.orderBy('age').reverse().limit(2).toArray()).map((f) => f.age), [41, 36]);
      eq((await db.friends.orderBy('age').offset(2).limit(9).toArray()).length, 2);
    });

    await check('or() union', async () => {
      const names = (await db.friends.where('name').equals('ada').or('name').equals('cy').toArray()).map((f) => f.name);
      eq(names.sort(), ['ada', 'cy']);
    });

    await check('update is a merge patch', async () => {
      const ada = await db.friends.where('name').equals('ada').first();
      await db.friends.update(ada.id, { meta: { city: 'london' } });
      await db.friends.update(ada.id, { meta: { zip: 'N1' } });
      eq((await db.friends.get(ada.id)).meta, { city: 'london', zip: 'N1' });
    });

    await check('atomic transaction across tables', async () => {
      await db.transaction((tx) => {
        tx.friends.add({ name: 'eve', age: 22, tags: [] });
        tx.notes.add({ owner: 'eve' });
      });
      eq(await db.friends.count(), 5);
      eq(await db.notes.count(), 1);
    });

    await check('liveQuery emits on change and not on no-op', async () => {
      const seen = [];
      const sub = db.liveQuery(() => db.friends.where('age').above(30).toArray())
        .subscribe((rows) => seen.push(rows.length));
      await sleep(80);
      if (seen.length !== 1) throw new Error(`no initial emit (${seen.length})`);
      await db.friends.add({ name: 'fay', age: 50, tags: [] });
      await sleep(80);
      if (seen.length !== 2) throw new Error(`no emit on change (${seen.length})`);
      await db.friends.add({ name: 'gil', age: 5, tags: [] });
      await sleep(80);
      if (seen.length !== 2) throw new Error(`emitted when result was unchanged (${seen.length})`);
      sub.unsubscribe();
    });

    await check('delete / modify through a collection', async () => {
      await db.friends.where('name').equals('gil').delete();
      eq(await db.friends.where('name').equals('gil').count(), 0);
      await db.friends.where('age').below(30).modify({ junior: true });
      const bob = await db.friends.where('name').equals('bob').first();
      eq(bob.junior, true);
    });

    await check('a second tab shares ONE writer (cross-tab routing)', async () => {
      const db2 = makeDb(2);
      await db2.open();
      const n = await db.friends.count();
      await db2.friends.add({ name: 'zed', age: 99, tags: [] });
      eq(await db.friends.count(), n + 1, 'a write from the second client must be visible to the first:');
      await db2.friends.where('name').equals('zed').delete();
      await db2.close();
    });

    await check('value fidelity vs structured clone (Date/bool/NaN/BigInt/null)', async () => {
      const when = new Date('2021-05-05T06:07:08.900Z');
      const id = await db.friends.add({
        name: 'codec', age: 1, tags: [], when, flag: true, off: false,
        nan: NaN, inf: Infinity, nil: null, big: 12345678901234567890n, empty: '', zero: 0,
      });
      const g = await db.friends.get(id);
      if (!(g.when instanceof Date)) throw new Error(`Date came back as ${typeof g.when}`);
      eq(g.when.toISOString(), when.toISOString(), 'Date:');
      eq([g.flag, g.off, g.nil, g.empty, g.zero], [true, false, null, '', 0], 'scalars:');
      if (!Number.isNaN(g.nan)) throw new Error('NaN lost');
      if (g.inf !== Infinity) throw new Error('Infinity lost');
      if (g.big !== 12345678901234567890n) throw new Error('BigInt lost');
      await db.friends.delete(id);
    });

    await check('boolean binds as a SQL parameter (sqlite-wasm)', async () => {
      const id = await db.friends.add({ name: 'boolq', age: 2, flag: true, tags: [] });
      eq(await db.friends.where('flag').equals(true).count(), 1);
      eq(await db.friends.where('flag').equals(false).count(), 0);
      await db.friends.delete(id);
    });

    await check('Date stays order-comparable through its index', async () => {
      const ids = [];
      for (const iso of ['2020-01-01', '2021-01-01', '2022-01-01'])
        ids.push(await db.friends.add({ name: `d${iso}`, age: 3, when: new Date(iso), tags: [] }));
      const after = await db.friends.where('when').above(new Date('2020-06-01')).toArray();
      eq(after.length, 2, 'Date range query:');
      if (!after.every((f) => f.when instanceof Date)) throw new Error('revive failed in a range query');
      await db.friends.bulkDelete(ids);
    });

    await check('update({x: null}) SETS null (json_patch would delete)', async () => {
      const id = await db.friends.add({ name: 'nulls', age: 4, tags: [] });
      await db.friends.update(id, { age: null });
      const g = await db.friends.get(id);
      if (!('age' in g)) throw new Error('key was deleted instead of set to null');
      eq(g.age, null);
      await db.friends.delete(id);
    });

    await check('bulkGet returns docs in order', async () => {
      const keys = await db.friends.orderBy('age').primaryKeys();
      const docs = await db.friends.bulkGet(keys);
      eq(docs.length, keys.length);
      eq(docs.map((d) => d.id), keys);
    });

    window.__PHASE1_COUNT__ = await db.friends.count();
    document.getElementById('handoff').textContent = String(window.__PHASE1_COUNT__);
  }

  if (PHASE === 'reload') {
    db = makeDb(2);
    await check('reopen an existing OPFS database', async () => {
      meta = await db.open();
      if (meta.version !== 2) throw new Error(`version ${meta.version}`);
    });

    await check('DATA SURVIVED A FULL RELOAD (real OPFS durability)', async () => {
      const n = await db.friends.count();
      // This phase ends by deleting the database, so it is destructive and
      // order-dependent: it only means anything immediately after ?phase=fresh.
      if (n === 0) throw new Error('database is empty — run ?phase=fresh first, then reload this phase');
      if (n < 5) throw new Error(`only ${n} rows survived`);
      const ada = await db.friends.where('name').equals('ada').first();
      if (!ada) throw new Error('ada missing after reload');
      eq(ada.meta, { city: 'london', zip: 'N1' }, 'nested merge survived:');
      eq((await db.friends.where('tags').equals('math').toArray()).map((f) => f.name).sort(), ['ada', 'cy'], 'multiEntry index survived:');
    });

    await check('migration is a no-op on reopen', async () => {
      if (meta.migrated !== false) throw new Error('re-migrated an already-current file');
    });

    await check('deleteDatabase wipes the OPFS file', async () => {
      await db.deleteDatabase();
      await sleep(150);
      const db3 = makeDb(2);
      await db3.open();
      eq(await db3.friends.count(), 0);
      await db3.close();
    });
  }

  await db?.close();

  const failed = results.filter((r) => !r.ok);
  window.__RESULTS__ = { phase: PHASE, total: results.length, failed: failed.length, results };
  document.getElementById('summary').textContent =
    failed.length === 0 ? `ALL ${results.length} PASSED (${PHASE})` : `${failed.length} of ${results.length} FAILED`;
  document.getElementById('summary').className = failed.length ? 'fail' : 'ok';
  document.title = failed.length ? `FAIL ${failed.length}` : `PASS ${results.length}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

run().catch((err) => {
  log('harness', false, err?.stack ?? String(err));
  window.__RESULTS__ = { phase: PHASE, fatal: String(err?.stack ?? err), failed: 1 };
  document.getElementById('summary').textContent = 'FATAL: ' + err.message;
  document.getElementById('summary').className = 'fail';
  document.title = 'FATAL';
});
