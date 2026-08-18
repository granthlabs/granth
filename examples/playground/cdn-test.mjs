/**
 * Does the CDN path actually work, end to end, from a real browser?
 *
 * NOT part of `npm test`, deliberately: it fetches from esm.sh, and the suite is
 * offline-safe on purpose (scripts/no-network.mjs enforces that in CI). This is
 * the same category as scale-test.mjs and safari-test.mjs — run it by hand
 * before a release, or after touching packages/core/client/src/cdn.ts.
 *
 *     node examples/playground/cdn-test.mjs [version]
 *
 * It runs the LOCAL build of cdnWorker() but points the generated worker at a
 * PUBLISHED version, since that is the only thing a CDN can serve. Pass the
 * version explicitly when testing a build that is not on npm yet.
 *
 * What it pins down, all of which was measured rather than assumed:
 *   - a Worker cannot be constructed from a cross-origin URL at all;
 *   - a blob: worker CAN import across origins, and reaches real OPFS;
 *   - the whole thing needs no file hosted by the person using it.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = join(HERE, '../../packages/core/client/dist');
const VERSION = process.argv[2] ?? '0.2.7';

const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.map': 'application/json' };

const server = createServer((req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  if (path === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(PAGE);
  }
  // Serve the LOCAL client build, so cdnWorker() under test is the one in this
  // working tree rather than whatever is already published.
  const file = join(CLIENT_DIST, path.replace(/^\/dist\//, ''));
  if (file.startsWith(CLIENT_DIST) && existsSync(file)) {
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    return res.end(readFileSync(file));
  }
  res.writeHead(404).end('not found');
});

/**
 * The local build still imports its siblings by bare specifier — a real CDN
 * rewrites those, a plain file server cannot. An import map stands in for that
 * rewriting so the code under test is this working tree's cdn.js while its
 * dependencies come from the same place a browser would really get them.
 */
const SIBLINGS = [
  'granth-protocol', 'granth-engine', 'granth-runtime-worker', 'granth-runtime-inline',
  'granth-storage-opfs', 'granth-storage-indexeddb', 'granth-storage-memory', 'opfs-leader',
];
const IMPORT_MAP = JSON.stringify({
  imports: Object.fromEntries(SIBLINGS.map((p) => [p, `https://esm.sh/${p}@${VERSION}`])),
});

const PAGE = `<!doctype html><meta charset="utf-8"><title>cdn</title><body><pre id="o"></pre>
<script type="importmap">${IMPORT_MAP}</script>
<script type="module">
const notes = [];
const log = (m) => { notes.push(m); document.getElementById('o').textContent = notes.join('\\n'); };
try {
  // A Worker must be same-origin. Stated as a measurement, not a belief.
  try { new Worker('https://esm.sh/granthdb@${VERSION}/worker', { type: 'module' }); log('cross-origin Worker: ALLOWED (unexpected)'); }
  catch (e) { log('cross-origin Worker: blocked (' + e.name + ') — as designed'); }

  const { cdnWorker } = await import('/dist/cdn.js');
  const { Granth } = await import('/dist/index.js');

  const db = new Granth('cdn-check', {
    worker: cdnWorker({ version: '${VERSION}', filename: '/cdn-check.sqlite3' }),
  });
  db.version(1).stores({ friends: '++id, name, age, *tags' });
  await db.open();
  const kind = await db.storageKind();

  await db.friends.bulkAdd([
    { name: 'Ada', age: 36, tags: ['maths'] },
    { name: 'Grace', age: 45, tags: ['maths', 'navy'] },
    { name: 'Radia', age: 28, tags: ['networks'] },
  ]);
  const grown = await db.friends.where('age').above(30).orderBy('name').toArray();
  const tagged = await db.friends.where('tags').equals('maths').count();
  await db.friends.update(1, { age: 37 });
  const ada = await db.friends.get(1);
  await db.deleteDatabase();

  window.__RESULT__ = {
    kind, notes,
    names: grown.map((f) => f.name),
    taggedMaths: tagged,
    adaAge: ada.age,
  };
} catch (e) {
  window.__RESULT__ = { error: String(e && e.message || e).slice(0, 300), notes };
}
</script>`;

await new Promise((r) => server.listen(0, r));
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  page error:', e.message));

await page.goto(`http://localhost:${server.address().port}/`);
let res;
try {
  await page.waitForFunction(() => window.__RESULT__ !== undefined, null, { timeout: 180_000 });
  res = await page.evaluate(() => window.__RESULT__);
} catch {
  res = { error: 'timed out — is the network up?' };
}
await browser.close();
server.close();

for (const n of res.notes ?? []) console.log(`  ${n}`);

const checks = [
  ['a cross-origin Worker is refused', (res.notes ?? []).some((n) => n.includes('blocked'))],
  ['the blob worker opened a database', !!res.kind],
  ['it reached OPFS, not just the fallback', res.kind === 'opfs'],
  ['an indexed, ordered query is correct', JSON.stringify(res.names) === '["Ada","Grace"]'],
  ['a multiEntry query is correct', res.taggedMaths === 2],
  ['a merge-patch update applied', res.adaAge === 37],
];

if (res.error) {
  console.error(`\nFAILED — ${res.error}`);
  process.exit(1);
}
let bad = 0;
for (const [name, ok] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
console.log(
  bad ? `\n${bad} check(s) failed against granthdb@${VERSION} on esm.sh`
      : `\ncdn: granthdb@${VERSION} runs from esm.sh with no local files, on ${res.kind}`
);
process.exit(bad ? 1 : 0);
