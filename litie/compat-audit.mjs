// Run: node compat-audit.mjs [--assert]
//
// Diffs our API against the REAL dexie package (a devDependency), so the
// compatibility matrix is generated, never hand-maintained. With --assert it
// fails when we regress or when Dexie grows a method we don't cover — which is
// the only way a "drop-in replacement" claim stays true over time.

import 'fake-indexeddb/auto';
import DexiePkg from 'dexie';
import { Litie } from './index.js';

const Dexie = DexiePkg.default ?? DexiePkg;

const walk = (o) => {
  const s = new Set();
  for (let p = o; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const n of Object.getOwnPropertyNames(p)) {
      if (n !== 'constructor' && !n.startsWith('_')) s.add(n);
    }
  }
  return s;
};

const SCHEMA = { t: '++id, name, age, *tags, [name+age]' };

const dx = new Dexie('probe');
dx.version(1).stores(SCHEMA);

const bd = new Litie('probe', {
  worker: () => { throw new Error('not used'); },
  locks: { request() {} }, // shape-only probe: never elects, never calls the worker
});
bd.version(1).stores(SCHEMA);
const bdTable = bd.table('t');
const bdColl = bdTable.toCollection();
const bdWhere = bdTable.where('name');

/**
 * Members we knowingly do not implement, each with the reason. Anything NOT in
 * this list and NOT implemented is a bug, not a decision.
 */
const WONT_IMPLEMENT = {
  'Dexie.use': 'middleware/addon pipeline — no equivalent; litie has no DBCore layer',
  'Dexie.unuse': 'see use',
  'Dexie.backendDB': 'exposes the raw IDBDatabase; there is no IDBDatabase here',
  'Dexie.dynamicallyOpened': 'Dexie-internal',
  'Dexie.vip': 'Dexie PSD/zone internal',
  'Dexie.idbdb': 'the raw IDBDatabase; there is no IndexedDB connection here',
  'Table.defineClass': 'deprecated in Dexie itself; use mapToClass',
  'Collection.raw': 'Dexie-internal escape hatch around hooks/mapToClass',
  'Collection.clone': 'Dexie-internal; our collections are already immutable per step',
};

const groups = [
  ['Dexie', walk(dx), walk(bd)],
  ['Table', walk(dx.t), walk(bdTable)],
  ['Collection', walk(dx.t.toCollection()), walk(bdColl)],
  ['WhereClause', walk(dx.t.where('name')), walk(bdWhere)],
];

let missing = 0;
const report = [];

for (const [name, theirs, ours] of groups) {
  const gaps = [...theirs].filter((m) => !ours.has(m)).sort();
  const real = gaps.filter((m) => !(`${name}.${m}` in WONT_IMPLEMENT));
  const waived = gaps.filter((m) => `${name}.${m}` in WONT_IMPLEMENT);
  missing += real.length;
  const covered = [...theirs].filter((m) => ours.has(m)).length;
  report.push(
    `${name}: ${covered}/${theirs.size} covered` +
      (real.length ? `\n  MISSING: ${real.join(' ')}` : '') +
      (waived.length ? `\n  waived:  ${waived.join(' ')}` : '')
  );
}

console.log(`dexie ${Dexie.semVer}\n` + report.join('\n'));

// Both a Litie BroadcastChannel and fake-indexeddb keep the loop alive.
bd.close();
if (process.argv.includes('--assert') && missing) {
  console.error(`\ncompat-audit: ${missing} un-waived Dexie member(s) missing`);
  process.exit(1);
}
process.exit(0);
