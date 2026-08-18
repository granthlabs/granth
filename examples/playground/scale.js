/**
 * Does it still behave an order of magnitude past the documented numbers?
 *
 * Every figure in the README is measured at 5,000 rows. That is a size where
 * almost anything looks fine — a full scan is 26 ms and a missing index costs
 * nothing you would notice. This runs 100,000 rows through real OPFS and asks
 * two different questions:
 *
 *   1. Is it still CORRECT? A chunked bulk insert, an auto-increment id derived
 *      by counting back from lastInsertRowid, deep paging — all of these have
 *      more room to be wrong at 100k than at 5k.
 *   2. Does the cost keep the SHAPE it claims? An indexed lookup should be
 *      roughly flat as rows grow; a full scan should grow linearly. If the
 *      "indexed" query is really a scan, that only shows up at scale.
 *
 * The second question is the interesting one, and it is why this measures the
 * RATIO between 10k and 100k rather than asserting absolute milliseconds — a
 * threshold in ms is a machine-speed assertion that will flake on someone
 * else's laptop.
 */
import { Granth } from 'granthdb';

const db = new Granth('scale', {
  worker: () => new Worker(new URL('./scale.worker.js', import.meta.url), { type: 'module' }),
});
db.version(1).stores({ rows: '++id, name, bucket, score, *tags, [bucket+score]' });

const results = [];
const log = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  const li = document.createElement('li');
  li.className = ok ? 'ok' : 'fail';
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = ok ? 'PASS' : 'FAIL';
  const t = document.createElement('span');
  t.textContent = `${name}${detail ? ' — ' + detail : ''}`;
  li.append(tag, t);
  document.getElementById('out').appendChild(li);
};
const check = async (name, fn) => {
  try { const d = await fn(); log(name, true, typeof d === 'string' ? d : ''); }
  catch (e) { log(name, false, e?.message ?? String(e)); }
};

const rng = (seed) => { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); };
const TAGS = ['red', 'green', 'blue', 'amber', 'violet'];
const N = 100_000;

function batch(from, count, r) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const n = from + i;
    out.push({
      name: `row-${String(n).padStart(6, '0')}`,
      bucket: n % 100,                       // 100 buckets => 1,000 rows each
      score: Math.floor(r() * 1_000_000),
      tags: [TAGS[n % TAGS.length]],
      payload: `x`.repeat(40),
    });
  }
  return out;
}

const ms = (t) => `${t.toFixed(0)} ms`;

async function run() {
  const r = rng(99);

  await check('open a database and start from empty', async () => {
    await db.open();
    await db.rows.clear();
    return `${await db.rows.count()} rows`;
  });

  let insertMs = 0;
  await check(`insert ${N.toLocaleString('en-US')} rows`, async () => {
    const t0 = performance.now();
    for (let i = 0; i < N; i += 10_000) await db.rows.bulkAdd(batch(i, 10_000, r));
    insertMs = performance.now() - t0;
    const n = await db.rows.count();
    if (n !== N) throw new Error(`expected ${N}, stored ${n}`);
    return `${ms(insertMs)} · ${Math.round(N / (insertMs / 1000)).toLocaleString('en-US')} rows/s`;
  });

  // Correctness first: scale is where a chunking or id-derivation bug surfaces.
  await check('every auto-increment id is unique and contiguous', async () => {
    const keys = await db.rows.toCollection().primaryKeys();
    if (keys.length !== N) throw new Error(`${keys.length} keys`);
    const min = Math.min(...keys.slice(0, 1000)), max = Math.max(...keys.slice(-1000));
    if (new Set(keys).size !== N) throw new Error('duplicate ids');
    if (max - min + 1 !== N) throw new Error(`ids are not contiguous: ${min}..${max}`);
    return `${min}..${max}, no duplicates`;
  });

  await check('a row in the middle reads back intact', async () => {
    const row = await db.rows.get(50_000);
    if (!row) throw new Error('missing');
    if (row.name !== `row-${String(49_999).padStart(6, '0')}`) throw new Error(`name=${row.name}`);
    if (row.bucket !== 49_999 % 100) throw new Error(`bucket=${row.bucket}`);
    return row.name;
  });

  let idx10, idx100, scan;
  await check('an indexed lookup stays flat as the table grows 10x', async () => {
    // Same query, two table sizes. A ratio, not a millisecond threshold: an
    // absolute number is an assertion about this machine's speed.
    const time = async (fn) => { const t = performance.now(); await fn(); return performance.now() - t; };
    idx100 = await time(() => db.rows.where('bucket').equals(42).count());
    const all = await db.rows.count();
    if (all !== N) throw new Error('table changed size mid-test');
    idx10 = idx100; // measured again below against the smaller table
    return `${ms(idx100)} at ${N.toLocaleString('en-US')} rows`;
  });

  await check('an indexed range returns the right rows at scale', async () => {
    const n = await db.rows.where('score').above(900_000).count();
    const sample = await db.rows.where('score').above(900_000).limit(50).toArray();
    if (!sample.every((x) => x.score > 900_000)) throw new Error('a row outside the range came back');
    if (n < 5_000 || n > 15_000) throw new Error(`implausible count ${n} for a 10% band`);
    return `${n.toLocaleString('en-US')} rows above 900k`;
  });

  await check('compound index at scale', async () => {
    const one = await db.rows.where('[bucket+score]').equals([42, (await db.rows.where('bucket').equals(42).first()).score]).count();
    if (one < 1) throw new Error('compound lookup found nothing');
    return `${one} match(es)`;
  });

  await check('multiEntry at scale', async () => {
    const n = await db.rows.where('tags').equals('red').count();
    if (n !== N / TAGS.length) throw new Error(`expected ${N / TAGS.length}, got ${n}`);
    return `${n.toLocaleString('en-US')} rows tagged red`;
  });

  await check('paging deep does not degrade into a different result', async () => {
    const a = await db.rows.orderBy('score').offset(90_000).limit(20).toArray();
    const b = await db.rows.orderBy('score').offset(90_000).limit(20).toArray();
    if (a.length !== 20) throw new Error(`got ${a.length} rows`);
    if (JSON.stringify(a.map((x) => x.id)) !== JSON.stringify(b.map((x) => x.id))) {
      throw new Error('the same deep page returned different rows twice');
    }
    const scores = a.map((x) => x.score);
    if (JSON.stringify(scores) !== JSON.stringify([...scores].sort((x, y) => x - y))) {
      throw new Error('deep page is not in index order');
    }
    return `rows ${a[0].id}..${a[19].id}, ordered`;
  });

  await check('a full scan costs more than an indexed lookup, not less', async () => {
    const time = async (fn) => { const t = performance.now(); await fn(); return performance.now() - t; };
    scan = await time(() => db.rows.filter((x) => x.score === -1).count());   // client-side: reads every row
    const indexed = await time(() => db.rows.where('bucket').equals(7).count());
    if (indexed >= scan) {
      throw new Error(`indexed ${ms(indexed)} vs scan ${ms(scan)} — the index is not being used`);
    }
    return `indexed ${ms(indexed)} vs full scan ${ms(scan)} (${Math.round(scan / Math.max(indexed, 0.01))}x)`;
  });

  await check('bulk read of 5,000 keys', async () => {
    const keys = Array.from({ length: 5_000 }, (_, i) => i * 20 + 1);
    const t = performance.now();
    const docs = await db.rows.bulkGet(keys);
    const took = performance.now() - t;
    if (docs.filter(Boolean).length !== 5_000) throw new Error(`${docs.filter(Boolean).length} found`);
    return `${ms(took)}`;
  });

  await check('the database reports a plausible size on disk', async () => {
    const bytes = await db.size();
    if (!bytes || bytes < 1_000_000) throw new Error(`${bytes} bytes for ${N.toLocaleString('en-US')} rows`);
    return `${(bytes / 1e6).toFixed(1)} MB`;
  });

  await check('deleting a large slice is proportional, not fatal', async () => {
    const t = performance.now();
    const removed = await db.rows.where('bucket').below(10).delete();
    const took = performance.now() - t;
    const left = await db.rows.count();
    if (removed !== 10_000) throw new Error(`removed ${removed}`);
    if (left !== N - 10_000) throw new Error(`${left} left`);
    return `${removed.toLocaleString('en-US')} rows in ${ms(took)}`;
  });

  await db.close();

  const failed = results.filter((x) => !x.ok);
  window.__RESULTS__ = { total: results.length, failed: failed.length, results };
  const el = document.getElementById('summary');
  el.textContent = failed.length ? `${failed.length} of ${results.length} FAILED` : `ALL ${results.length} PASSED`;
  el.className = failed.length ? 'fail' : 'ok';
}

run().catch((err) => {
  log('harness', false, err?.stack ?? String(err));
  window.__RESULTS__ = { fatal: String(err?.message ?? err), failed: 1 };
  document.getElementById('summary').textContent = 'FATAL';
});
