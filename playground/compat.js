// Verifies the two things Node cannot: the IndexedDB fallback backend, and
// migrating a real Dexie database into granth.

import { Granth } from 'granth';
import { importFromIndexedDB, inspectIndexedDB, suggestSchema } from 'granth/migrate-idb';
import Dexie from 'dexie';

const results = [];
const log = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  const li = document.createElement('li');
  li.className = ok ? 'ok' : 'fail';
  li.textContent = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`;
  document.getElementById('out').appendChild(li);
};
async function check(name, fn) {
  try { await fn(); log(name, true); } catch (e) { log(name, false, e?.message ?? String(e)); }
}
const eq = (a, b, m = '') => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${m} expected ${B}, got ${A}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PHASE = new URLSearchParams(location.search).get('phase') ?? 'fresh';
const idbDb = () =>
  new Granth('fallback', {
    worker: () => new Worker(new URL('./idb.worker.js', import.meta.url), { type: 'module' }),
  });

const LEGACY = 'legacy-dexie-app';

async function run() {
  document.getElementById('phase').textContent = PHASE;

  // ---------------------------------------------------------------- fallback
  let db = idbDb();
  db.version(1).stores({ friends: '++id, name, age, *tags' });
  await db.open();

  await check('storage:indexeddb actually uses the IndexedDB backend', async () => {
    eq(await db.storageKind(), 'indexeddb');
  });

  if (PHASE === 'fresh') {
    await check('IndexedDB fallback: full query surface works identically', async () => {
      await db.friends.clear();
      await db.friends.bulkAdd([
        { name: 'ada', age: 36, tags: ['math'] },
        { name: 'bob', age: 25, tags: ['eng'] },
        { name: 'cy', age: 41, tags: ['math', 'eng'] },
      ]);
      eq(await db.friends.count(), 3);
      eq((await db.friends.where('age').above(30).toArray()).map((f) => f.name).sort(), ['ada', 'cy']);
      eq((await db.friends.where('tags').equals('math').toArray()).map((f) => f.name).sort(), ['ada', 'cy'],
         'multiEntry triggers must work on the fallback too:');
      eq(await db.friends.orderBy('age').keys(), [25, 36, 41]);
    });

    await check('IndexedDB fallback: checkpoint written', async () => {
      await db.flush();
      const names = await indexedDB.databases?.();
      if (names && !names.some((d) => d.name?.includes('fallback')))
        throw new Error('no IndexedDB database was created');
    });

    await check('a real IndexedDB snapshot exists and is non-trivial', async () => {
      const bytes = await new Promise((resolve, reject) => {
        const r = indexedDB.open('granthfallbacksqlite3');
        r.onsuccess = () => {
          const idb = r.result;
          const g = idb.transaction('files', 'readonly').objectStore('files').get('/fallback.sqlite3');
          g.onsuccess = () => { resolve(g.result); idb.close(); };
          g.onerror = () => { reject(g.error); idb.close(); };
        };
        r.onerror = () => reject(r.error);
      });
      if (!bytes || bytes.byteLength < 1000) throw new Error(`snapshot too small: ${bytes?.byteLength}`);
      const head = new TextDecoder().decode(new Uint8Array(bytes).slice(0, 15));
      if (!head.startsWith('SQLite format 3')) throw new Error(`not a SQLite file: ${head}`);
    });
    await db.close();

    // ------------------------------------------------------------- migration
    await check('seed a REAL Dexie database to migrate from', async () => {
      await Dexie.delete(LEGACY);
      const legacy = new Dexie(LEGACY);
      legacy.version(1).stores({ friends: '++id, name, age, *tags', notes: '++id, owner' });
      await legacy.open();
      await legacy.friends.bulkAdd([
        { name: 'legacy-1', age: 10, tags: ['old'] },
        { name: 'legacy-2', age: 20, tags: ['old', 'x'] },
      ]);
      await legacy.notes.bulkAdd([{ owner: 'legacy-1' }, { owner: 'legacy-2' }]);
      legacy.close();
    });

    await check('inspectIndexedDB reads the existing schema', async () => {
      const info = await inspectIndexedDB(LEGACY);
      eq(info.stores.map((s) => s.name).sort(), ['friends', 'notes']);
      const f = info.stores.find((s) => s.name === 'friends');
      eq(f.count, 2);
      eq(f.autoIncrement, true);
      if (!f.indexes.some((i) => i.name === 'tags' && i.multiEntry)) throw new Error('multiEntry index not detected');
    });

    await check('suggestSchema derives a granth stores() spec', async () => {
      const schema = await suggestSchema(LEGACY);
      if (!/\+\+id/.test(schema.friends)) throw new Error(`no auto key: ${schema.friends}`);
      if (!/\*tags/.test(schema.friends)) throw new Error(`multiEntry lost: ${schema.friends}`);
      if (!/\bname\b/.test(schema.friends)) throw new Error(`index lost: ${schema.friends}`);
    });

    await check('importFromIndexedDB copies a Dexie database in, with no manual work', async () => {
      const schema = await suggestSchema(LEGACY);
      const target = new Granth('migrated', {
        worker: () => new Worker(new URL('./migrated.worker.js', import.meta.url), { type: 'module' }),
      });
      target.version(1).stores(schema); // schema derived from the OLD database
      await target.open();
      await target.friends.clear();
      await target.notes.clear();

      const counts = await importFromIndexedDB(target, { from: LEGACY });
      eq(counts, { friends: 2, notes: 2 });
      eq(await target.friends.count(), 2);

      // keys and indexes must survive the move
      const one = await target.friends.where('name').equals('legacy-1').first();
      eq(one.age, 10);
      eq(typeof one.id, 'number', 'auto-increment key must be preserved:');
      eq((await target.friends.where('tags').equals('old').toArray()).length, 2,
         'multiEntry index must be rebuilt from the imported docs:');

      // idempotent: re-running must not duplicate
      await importFromIndexedDB(target, { from: LEGACY });
      eq(await target.friends.count(), 2, 're-import must overwrite, not duplicate:');
      await target.close();
    });

    db = idbDb();
    db.version(1).stores({ friends: '++id, name, age, *tags' });
    await db.open();
    await db.flush();
  }

  if (PHASE === 'reload') {
    await check('IndexedDB fallback survived a FULL RELOAD', async () => {
      const n = await db.friends.count();
      if (n === 0) throw new Error('empty — run ?phase=fresh first');
      eq((await db.friends.where('tags').equals('math').toArray()).map((f) => f.name).sort(), ['ada', 'cy'],
         'indexes must survive the snapshot round trip:');
    });
  }

  await check('changing a schema without bumping the version fails LOUDLY', async () => {
    const drift = idbDb();
    drift.version(1).stores({ friends: '++id, name, age, *tags', brandNew: '++id, x' });
    let threw = null;
    try { await drift.open(); } catch (e) { threw = e; }
    await drift.close();
    if (!threw) throw new Error('silently accepted an undeclared table');
    if (!/need a NEW version/.test(threw.message)) throw new Error(`unhelpful error: ${threw.message}`);
  });

  await db.close();

  const failed = results.filter((r) => !r.ok);
  window.__RESULTS__ = { phase: PHASE, total: results.length, failed: failed.length, results };
  document.getElementById('summary').textContent =
    failed.length === 0 ? `ALL ${results.length} PASSED (${PHASE})` : `${failed.length} of ${results.length} FAILED`;
  document.getElementById('summary').className = failed.length ? 'fail' : 'ok';
  document.title = failed.length ? `FAIL ${failed.length}` : `PASS ${results.length}`;
}

run().catch((err) => {
  log('harness', false, err?.stack ?? String(err));
  window.__RESULTS__ = { fatal: String(err?.stack ?? err), failed: 1 };
  document.getElementById('summary').textContent = 'FATAL: ' + err.message;
  document.title = 'FATAL';
});
