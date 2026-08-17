import { Granth } from 'granthdb';

const rows = [];
const out = (name, ms, n, unit = 'ops') => {
  const rate = n ? Math.round(n / (ms / 1000)) : null;
  rows.push({ name, ms: +ms.toFixed(1), n, rate });
  const li = document.createElement('li');
  li.textContent = `${name.padEnd(42)} ${String(ms.toFixed(1)).padStart(8)} ms` + (rate ? `   ${rate.toLocaleString()} ${unit}/s` : '');
  document.getElementById('out').appendChild(li);
};

async function time(name, n, fn, unit) {
  const t0 = performance.now();
  await fn();
  out(name, performance.now() - t0, n, unit);
}

const N = Number(new URLSearchParams(location.search).get('n') ?? 5000);

const db = new Granth('bench', {
  worker: () => {
    const u = new URL('./bench.worker.js', import.meta.url);
    for (const k of ['sync', 'journal']) {
      const v = new URLSearchParams(location.search).get(k);
      if (v) u.searchParams.set(k, v);
    }
    return new Worker(u, { type: 'module' });
  },
});
db.version(1).stores({ items: '++id, name, n, cat, *tags, [cat+n]' });

const doc = (i) => ({
  name: `item-${i}`,
  n: i,
  cat: `cat-${i % 20}`,
  tags: [`t${i % 7}`, `t${i % 13}`],
  blob: 'x'.repeat(80),
});

await db.open();
await db.items.clear();

await time(`bulkAdd ${N} docs (one transaction)`, N, () => db.items.bulkAdd(Array.from({ length: N }, (_, i) => doc(i))), 'rows');

await time('add 200 docs one at a time (round trips)', 200, async () => {
  for (let i = 0; i < 200; i++) await db.items.add(doc(N + i));
}, 'rows');

const total = await db.items.count();
out(`table size`, 0, total, 'rows');

await time('count() whole table', 1, () => db.items.count());
await time('indexed: where(n).above(N*0.9)', 1, () => db.items.where('n').above(N * 0.9).toArray());
await time('indexed: where(cat).equals(cat-7)', 1, () => db.items.where('cat').equals('cat-7').toArray());
await time('compound: where([cat+n]).equals', 1, () => db.items.where('[cat+n]').equals(['cat-7', 7]).toArray());
await time('multiEntry: where(tags).equals(t3)', 1, () => db.items.where('tags').equals('t3').toArray());
await time('orderBy(n).limit(50)', 1, () => db.items.orderBy('n').limit(50).toArray());
await time('orderBy(n).offset(N/2).limit(50)', 1, () => db.items.orderBy('n').offset(N / 2).limit(50).toArray());
await time(`full scan toArray (${total} docs)`, total, () => db.items.toArray(), 'rows');

const keys = await db.items.orderBy('n').limit(500).primaryKeys();
await time('bulkGet 500 keys (ONE round trip)', 500, () => db.items.bulkGet(keys), 'keys');
await time('get() 500 keys one at a time', 500, async () => {
  for (const k of keys) await db.items.get(k);
}, 'keys');

await time('JS .filter() over full table (client-side)', total, () => db.items.filter((d) => d.n % 1000 === 0).toArray(), 'rows');
await time('modify 500 rows (indexed)', 500, () => db.items.where('n').below(500).modify({ touched: true }), 'rows');
await time('delete 500 rows (indexed)', 500, () => db.items.where('n').below(500).delete(), 'rows');

const bytes = await db._client.call('size');
out(`file size on OPFS`, 0, Math.round(bytes / 1024), 'KiB');

window.__BENCH__ = { n: N, rows };
document.getElementById('summary').textContent = `done — ${total} rows, file ${Math.round(bytes / 1024)} KiB`;
document.title = 'BENCH DONE';
await db.close();
