// The codemod must rewrite what is safe and REFUSE the rest. Both halves are
// tested: a codemod that silently mangles code is worse than no codemod.
import assert from 'node:assert/strict';
import { transform, workerScaffold } from './dist/index.js';

const has = (notes, re) => notes.some((n) => re.test(n.message));

// --- 1. the plain case ------------------------------------------------------
{
  const src = `import Dexie from 'dexie';
const db = new Dexie('myapp');
db.version(1).stores({ friends: '++id, name, age, *tags' });
export default db;`;
  const { code, changed, notes } = transform(src, 'db.js');
  assert.ok(changed);
  assert.match(code, /import Granth from 'granthdb'/);
  assert.match(code, /new Granth\('myapp', \{/);
  assert.match(code, /worker: \(\) => new Worker\(new URL\('\.\/db\.worker\.js', import\.meta\.url\), \{ type: 'module' \}\)/);
  assert.match(code, /db\.version\(1\)\.stores/, 'schema strings must be left alone');
  assert.ok(has(notes, /worker file is required/));
  assert.ok(!/Dexie/.test(code), `no Dexie references should remain:\n${code}`);
}

// --- 2. subclass form (the Dexie idiom for typed tables) --------------------
{
  const src = `import Dexie, { Table } from 'dexie';
export class MyDB extends Dexie {
  friends;
  constructor() {
    super('myapp');
    this.version(1).stores({ friends: '++id, name' });
  }
}`;
  const { code, notes } = transform(src, 'db.ts');
  assert.match(code, /export class MyDB extends Granth/);
  assert.match(code, /from 'granthdb'/);
  assert.ok(has(notes, /super\('name'\) must now pass a runtime/), 'must flag the super() call it cannot safely rewrite');
}

// --- 3. a renamed default import must still be tracked ----------------------
{
  const src = `import DB from 'dexie';\nconst x = new DB('a');`;
  const { code } = transform(src, 'a.js');
  assert.match(code, /import Granth from 'granthdb'/);
  assert.match(code, /new Granth\('a', \{/);
  assert.ok(!/\bDB\b/.test(code), `renamed import must be migrated too:\n${code}`);
}

// --- 4. react hooks package -------------------------------------------------
{
  const src = `import { useLiveQuery } from 'dexie-react-hooks';\nimport Dexie from 'dexie';`;
  const { code, notes } = transform(src, 'c.tsx');
  assert.match(code, /from 'granth-react'/);
  assert.ok(has(notes, /takes the db as its first argument/));
}

// --- 5. things it must REFUSE to rewrite ------------------------------------
{
  const src = `import Dexie from 'dexie';
const db = new Dexie('x');
db.version(2).stores({ a: '++id' }).upgrade(tx => tx.table('a').toCollection().modify(o => { o.v = 1; }));
db.use({ stack: 'dbcore', create: () => {} });
const p = Dexie.Promise.resolve();
const raw = db.backendDB();`;
  const { notes } = transform(src, 'd.js');
  assert.ok(has(notes, /upgrade\(\) callbacks cannot cross into the worker/));
  assert.ok(has(notes, /Dexie middleware/));
  assert.ok(has(notes, /Dexie\.Promise has no equivalent/));
  assert.ok(has(notes, /raw IDBDatabase/));
}

// --- 6. must not touch unrelated files or strings ---------------------------
{
  const src = `const s = "we migrated off dexie last year";\nconst q = 'new Dexie(...)';`;
  const { changed } = transform(src, 'e.js');
  assert.equal(changed, false, 'string contents must not be rewritten');
}
{
  const src = `import { openDB } from 'idb';\nconst db = await openDB('x');`;
  assert.equal(transform(src, 'f.js').changed, false, 'non-Dexie code must be untouched');
}

// --- 7. an existing options object is flagged, not clobbered ---------------
{
  const src = `import Dexie from 'dexie';\nconst db = new Dexie('x', { autoOpen: false });`;
  const { code, notes } = transform(src, 'g.js');
  assert.match(code, /\{ autoOpen: false \}/, 'existing options must be preserved verbatim');
  assert.ok(has(notes, /add `worker/), 'must tell the human to add the worker option');
}

// --- 8. the scaffold it writes must be usable -------------------------------
{
  const w = workerScaffold('/myapp.sqlite3');
  assert.match(w, /startGranthWorker/);
  assert.match(w, /storage: \[opfsStorage\(\), indexeddbStorage\(\), memoryStorage\(\)\]/);
  assert.match(w, /\/myapp\.sqlite3/);
}

console.log('codemod: all assertions passed');
