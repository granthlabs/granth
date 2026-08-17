/**
 * Docs coverage audit — generated, not claimed.
 *
 * "The docs cover everything" is the kind of statement that is true the day it
 * is written and quietly false three commits later. This enumerates the ACTUAL
 * public API off the live prototypes and fails if any member is missing from
 * docs/, so adding a method without documenting it breaks the build.
 *
 * Members that are deliberately undocumented go in WAIVED, with a reason. A
 * waiver is a decision on the record; silence is not.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as main from 'granthdb';
import { createEngine, rpcHandlers } from 'granth-engine';
import { inlineRuntime } from 'granth-runtime-inline';

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '../../../docs');

/** name -> why it is not in the docs. */
const WAIVED = {
  then: 'thenable plumbing, not API',
  catch: 'thenable plumbing, not API',
  finally: 'thenable plumbing, not API',
  constructor: 'not API',
};

const adapter = (db) => ({
  all: (s, p = []) => db.prepare(s).all(...p).map((r) => ({ ...r })),
  exec: (s) => db.exec(s),
  run: (s, p = []) => {
    const r = db.prepare(s).run(...p);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  },
  createFunction: (n, f) => db.function(n, f),
});

const engine = createEngine(adapter(new DatabaseSync(':memory:')));
const db = new main.Granth('coverage', {
  runtime: inlineRuntime({ createHandlers: async () => rpcHandlers(() => engine) }),
});
db.version(1).stores({ t: '++id, name, age, *tags, [name+age]' });
await db.open();

const protoNames = (o) => {
  const names = new Set();
  let p = Object.getPrototypeOf(o);
  while (p && p !== Object.prototype) {
    for (const k of Object.getOwnPropertyNames(p)) names.add(k);
    p = Object.getPrototypeOf(p);
  }
  return [...names].filter((k) => !k.startsWith('_') && !(k in WAIVED)).sort();
};

const surface = {
  Granth: protoNames(db),
  Table: protoNames(db.t),
  WhereClause: protoNames(db.t.where('age')),
  Collection: protoNames(db.t.where('age').above(1)),
  exports: Object.keys(main).filter((k) => !(k in WAIVED)).sort(),
};

const docs = readdirSync(DOCS)
  .filter((f) => f.endsWith('.md'))
  .map((f) => readFileSync(join(DOCS, f), 'utf8'))
  .join('\n');

let missing = 0;
for (const [group, names] of Object.entries(surface)) {
  const undocumented = names.filter((n) => !new RegExp(`\\b${n.replace(/\$/g, '\\$')}\\b`).test(docs));
  console.log(`${group.padEnd(12)} ${names.length - undocumented.length}/${names.length}`);
  if (undocumented.length) {
    missing += undocumented.length;
    console.log(`   UNDOCUMENTED: ${undocumented.join(', ')}`);
  }
}

if (process.argv.includes('--assert') && missing) {
  console.error(`\n${missing} public API members are not mentioned anywhere in docs/.`);
  process.exit(1);
}
console.log(missing ? `\n${missing} undocumented` : '\nfull API coverage');
process.exit(0);
