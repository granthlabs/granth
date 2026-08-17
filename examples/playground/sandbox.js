/**
 * Interactive sandbox.
 *
 * A real database, not a simulation: the same worker, the same OPFS file, the
 * same code path an app takes. The point is that someone can decide whether the
 * API fits their problem in thirty seconds, without installing anything.
 *
 * Snippets are evaluated with `new Function`, which is normally a thing to avoid
 * — here the code comes from the person typing it, into their own browser, with
 * no privileged scope to reach. That is a REPL, not an injection vector. It is
 * also why the sandbox is an example and not shipped in a library.
 */

import { Granth } from 'granthdb';

const db = new Granth('sandbox', {
  worker: () => new Worker(new URL('./sandbox.worker.js', import.meta.url), { type: 'module' }),
});
// [name+age] is declared because an EXAMPLE queries it. The smoke test runs
// every example, which is how a schema that did not match its own demo was caught.
db.version(1).stores({
  friends: '++id, name, age, city, *tags, [name+age]',
  notes: '++id, friendId, created',
});

const $ = (id) => document.getElementById(id);
const out = $('out');
const tableBox = $('table');

const EXAMPLES = [
  {
    label: 'Filter on one index, order by another',
    code: `// A cursor-based store cannot do this in one pass.\nreturn db.friends\n  .where('age').between(25, 40)\n  .orderBy('name')\n  .toArray();`,
  },
  {
    label: 'Count without iterating',
    code: `return db.friends.where('city').equals('Lisbon').count();`,
  },
  {
    label: 'multiEntry: match any tag',
    code: `return db.friends.where('tags').equals('design').toArray();`,
  },
  {
    label: 'Compound index',
    code: `return db.friends.where('[name+age]').equals(['Ada', 36]).toArray();`,
  },
  {
    label: 'Add a row (watch the count change)',
    code: `await db.friends.add({\n  name: 'New Person',\n  age: 30,\n  city: 'Porto',\n  tags: ['new'],\n});\nreturn db.friends.count();`,
  },
  {
    label: 'Update is a merge patch',
    code: `const ada = await db.friends.where('name').equals('Ada').first();\nawait db.friends.update(ada.id, { city: 'Reykjavik' });\nreturn db.friends.get(ada.id);`,
  },
  {
    label: 'Transaction across two tables',
    code: `await db.transaction('rw', [db.friends, db.notes], async () => {\n  const id = await db.friends.add({ name: 'Tx Person', age: 41, city: 'Oslo', tags: [] });\n  await db.notes.add({ friendId: id, body: 'created in a transaction', created: new Date() });\n});\nreturn db.notes.orderBy('created').reverse().limit(3).toArray();`,
  },
  {
    label: 'Values survive the round trip',
    code: `// JSON destroys all of these. Structured clone does not, and neither does this.\nconst id = await db.friends.add({\n  name: 'Fidelity', age: NaN, city: 'X', tags: [],\n  when: new Date('2020-01-01'), big: 10n ** 25n, nothing: null,\n});\nconst back = await db.friends.get(id);\nreturn {\n  whenIsDate: back.when instanceof Date,\n  ageIsNaN: Number.isNaN(back.age),\n  bigIsBigInt: typeof back.big === 'bigint',\n  nullStayedNull: back.nothing === null,\n};`,
  },
  {
    label: 'Paging deep into a table',
    code: `return db.friends.orderBy('name').offset(5).limit(5).toArray();`,
  },
];

const SEED = [
  { name: 'Ada', age: 36, city: 'London', tags: ['maths', 'engines'] },
  { name: 'Grace', age: 45, city: 'New York', tags: ['compilers', 'navy'] },
  { name: 'Alan', age: 41, city: 'London', tags: ['maths', 'crypto'] },
  { name: 'Katherine', age: 52, city: 'Hampton', tags: ['maths', 'space'] },
  { name: 'Radia', age: 38, city: 'Boston', tags: ['networks'] },
  { name: 'Barbara', age: 33, city: 'Lisbon', tags: ['design', 'space'] },
  { name: 'Joan', age: 28, city: 'Lisbon', tags: ['design'] },
  { name: 'Margaret', age: 31, city: 'Boston', tags: ['software', 'space'] },
  { name: 'Hedy', age: 47, city: 'Vienna', tags: ['radio', 'design'] },
  { name: 'Annie', age: 26, city: 'Boston', tags: ['astronomy'] },
];

async function seed() {
  await db.friends.clear();
  await db.notes.clear();
  await db.friends.bulkAdd(SEED.map((f) => ({ ...f })));
}

function render(value, ms) {
  tableBox.innerHTML = '';
  $('timing').textContent = ms == null ? '' : `${ms.toFixed(1)} ms`;

  out.className = '';
  out.textContent = JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v), 2) ?? String(value);

  // An array of flat objects is a table; anything else stays as JSON, because a
  // table of one scalar is worse than the scalar.
  if (!Array.isArray(value) || value.length === 0) return;
  if (!value.every((r) => r && typeof r === 'object' && !Array.isArray(r))) return;

  const cols = [...new Set(value.flatMap((r) => Object.keys(r)))];
  const cell = (v) =>
    v === null ? 'null'
      : v instanceof Date ? v.toISOString()
      : typeof v === 'object' ? JSON.stringify(v)
      : String(v);

  const table = document.createElement('table');
  table.innerHTML =
    `<thead><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead>` +
    `<tbody>${value.map((r) => `<tr>${cols.map((c) => `<td>${cell(r[c])}</td>`).join('')}</tr>`).join('')}</tbody>`;
  tableBox.appendChild(table);
}

async function run() {
  const code = $('code').value;
  $('run').disabled = true;
  const t0 = performance.now();
  try {
    // Async so snippets can await. `db` is the only thing handed in.
    const fn = new Function('db', `return (async () => {\n${code}\n})();`);
    const value = await fn(db);
    render(value, performance.now() - t0);
  } catch (err) {
    tableBox.innerHTML = '';
    $('timing').textContent = '';
    out.className = 'err';
    out.textContent = `${err.name}: ${err.message}`;
  } finally {
    $('run').disabled = false;
  }
}

// ---- wiring ---------------------------------------------------------------

const select = $('examples');
for (const [i, ex] of EXAMPLES.entries()) {
  const opt = document.createElement('option');
  opt.value = String(i);
  opt.textContent = ex.label;
  select.appendChild(opt);
}
select.addEventListener('change', () => { $('code').value = EXAMPLES[Number(select.value)].code; });
$('code').value = EXAMPLES[0].code;

$('run').addEventListener('click', run);
$('code').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
});
$('reset').addEventListener('click', async () => {
  await seed();
  out.className = 'ok';
  out.textContent = `Reseeded ${SEED.length} rows.`;
  tableBox.innerHTML = '';
});

(async () => {
  try {
    await db.open();
    if ((await db.friends.count()) === 0) await seed();
    const [storage, runtime] = await Promise.all([db.storageKind(), db.runtimeKind()]);
    $('env').textContent = `storage: ${storage} · runtime: ${runtime} · ${await db.friends.count()} rows`;
    window.__SANDBOX_READY__ = true;     // the smoke test waits on this
  } catch (err) {
    $('env').textContent = `failed to open: ${err.message}`;
    window.__SANDBOX_ERROR__ = String(err.message);
  }
})();
