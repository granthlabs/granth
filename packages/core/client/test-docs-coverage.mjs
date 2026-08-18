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

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as main from 'granthdb';
import { createEngine, rpcHandlers } from 'granth-engine';
import { inlineRuntime } from 'granth-runtime-inline';

const SNAPSHOT = join(dirname(fileURLToPath(import.meta.url)), 'docs-surface.json');

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

/**
 * The docs live in the SITE repo since the split, but this gate stays HERE:
 * its whole value is failing BEFORE a release, and an undocumented member first
 * caught by the site's CI would already be on npm.
 *
 * It reads a COMMITTED snapshot of the identifiers those docs mention, not the
 * docs themselves. Fetching them per run was the obvious way to keep the gate
 * here, and it was wrong twice over: the suite failed with no network, and an
 * edit in another repository could turn this one's CI red without a line of code
 * changing. It cost one false failure during a release before that was noticed.
 *
 * Refresh it deliberately, after documenting something upstream:
 *
 *     npm run docs:refresh
 *
 * The snapshot going stale therefore fails CLOSED — a newly documented member
 * reads as undocumented until the snapshot is refreshed, which is a visible
 * chore, rather than a newly UNdocumented member reading as fine.
 */
if (!existsSync(SNAPSHOT)) {
  console.error(`docs-coverage: ${SNAPSHOT} is missing. Run: npm run docs:refresh`);
  process.exit(1);
}
const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
const documented = new Set(snapshot.names);

let missing = 0;
for (const [group, names] of Object.entries(surface)) {
  const undocumented = names.filter((n) => !documented.has(n));
  console.log(`${group.padEnd(12)} ${names.length - undocumented.length}/${names.length}`);
  if (undocumented.length) {
    missing += undocumented.length;
    console.log(`   UNDOCUMENTED: ${undocumented.join(', ')}`);
  }
}

if (process.argv.includes('--assert') && missing) {
  console.error(
    `\n${missing} public API member(s) are not mentioned anywhere in the docs.\n` +
      `Snapshot: ${snapshot.files.length} files from ${snapshot.source}` +
      `${snapshot.sha ? ` @ ${snapshot.sha.slice(0, 7)}` : ''}.\n` +
      `If you already documented these upstream, refresh it: npm run docs:refresh`
  );
  process.exit(1);
}
console.log(missing ? `\n${missing} undocumented` : '\nfull API coverage');
process.exit(0);
