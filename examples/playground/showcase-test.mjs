/**
 * Drives the showcase app the way a person would.
 *
 * This is the layer every other suite skips: a REAL app, 5,000 rows, filters and
 * sorting and paging combined, a transaction across two tables, and the same
 * data still there after a full reload. The demos prove a binding mounts; this
 * proves the library survives being used.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '../../docs/.vitepress/dist');
// The site is an ORG SITE now (granthlabs/granthlabs.github.io), served from
// the root. One constant so a future move is one edit.
const BASE = process.env.DOCS_BASE ?? '/';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png' };

if (!existsSync(join(DIST, 'play/showcase'))) {
  console.error('showcase-test: no build found. Run `npm run docs:build` first.');
  process.exit(1);
}

const server = createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel.startsWith(BASE)) rel = rel.slice(BASE.length);
  rel = rel.replace(/^\/+/, '');
  for (const c of [rel, `${rel}.html`, join(rel, 'index.html')]) {
    const f = join(DIST, c);
    if (f.startsWith(DIST) && existsSync(f) && statSync(f).isFile()) {
      res.writeHead(200, { 'content-type': TYPES[extname(f)] ?? 'application/octet-stream' });
      return res.end(readFileSync(f));
    }
  }
  res.writeHead(404).end('not found');
});
await new Promise((r) => server.listen(0, r));
const origin = `http://localhost:${server.address().port}`;
const URL_ = `${origin}${BASE}play/showcase/`;

const browser = await chromium.launch();
const ctx = await browser.newContext();
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};


/**
 * Wait for a render to COMPLETE, rather than sleeping and hoping.
 *
 * The first version of this file waited on a condition that was already true, so
 * it read the table before the filtered render had painted and reported a filter
 * bug that did not exist. Counting completed renders removes the guesswork.
 */
const settled = async (p, act) => {
  const before = await p.evaluate(() => window.__RENDERS__ ?? 0);
  await act();
  await p.waitForFunction((n) => (window.__RENDERS__ ?? 0) > n, before, { timeout: 30_000 });
};

const problems = [];
const open = async () => {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`${r.status()} ${r.url().replace(origin, '')}`); });
  await page.goto(URL_, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForFunction(() => window.__SHOWCASE_READY__ || window.__SHOWCASE_ERROR__, null, { timeout: 120_000 });
  return page;
};

const page = await open();
const err = await page.evaluate(() => window.__SHOWCASE_ERROR__);
check('the app opens a real database', !err, err ?? await page.textContent('#env'));

const rowCount = () => page.$$eval('#rows tr', (r) => r.length);
const timing = () => page.textContent('#timing');

check('it seeded and rendered a first page', (await rowCount()) === 25, `${await rowCount()} rows`);
check('5,000 issues are actually there', /5,000 issues/.test(await page.textContent('#env')),
  (await page.textContent('#env')).trim());

// Filter on one index while ordering by another — the headline claim.
await settled(page, () => page.click('[data-status="open"]'));
const openOnly = await page.$$eval('#rows .pill', (p) => [...new Set(p.map((x) => x.textContent))]);
check('filtering by status returns only that status', openOnly.length === 1 && openOnly[0] === 'open',
  openOnly.join(','));

const dates = await page.$$eval('#rows td.num:last-child', (t) => t.map((x) => x.textContent));
const sortedDesc = [...dates].sort().reverse();
check('and it is still ordered by date, not by primary key',
  JSON.stringify(dates) === JSON.stringify(sortedDesc), dates.slice(0, 3).join(' '));

// multiEntry facet.
await settled(page, () => page.click('#labels [data-label="perf"]'));
const labelled = await page.$$eval('#rows td.labels', (t) => t.map((x) => x.textContent));
check('a label facet returns only rows carrying that label',
  labelled.length > 0 && labelled.every((l) => l.includes('perf')), `${labelled.length} rows`);
await settled(page, () => page.click('#active-label'));

// Paging deep, which is where a wrong ORDER BY shows up as different ROWS.
await settled(page, () => page.click('[data-status="open"]'));   // toggle back to all
const firstPage = await page.$$eval('#rows td.t', (t) => t.map((x) => x.textContent));
await settled(page, () => page.click('#next'));
const secondPage = await page.$$eval('#rows td.t', (t) => t.map((x) => x.textContent));
const overlap = firstPage.filter((t) => secondPage.includes(t));
check('page 2 shares no rows with page 1', overlap.length === 0, `${overlap.length} repeated`);

await settled(page, () => page.click('#prev'));
const backAgain = await page.$$eval('#rows td.t', (t) => t.map((x) => x.textContent));
check('paging back returns the same rows', JSON.stringify(backAgain) === JSON.stringify(firstPage));

// Search combines with everything else.
await settled(page, () => page.fill('#search', 'race'));
const titles = await page.$$eval('#rows td.t', (t) => t.map((x) => x.textContent.toLowerCase()));
check('search narrows the result set', titles.length > 0 && titles.every((t) => t.includes('race')),
  `${titles.length} rows`);
await settled(page, () => page.fill('#search', ''));

// A transaction across two tables, and the live query that reflects it.
const beforeOpen = Number((await page.textContent('#timing')).replace(/[^0-9]/g, '').slice(0, 4) || 0);
await settled(page, () => page.click('#triage'));
const afterCounts = await page.$$eval('#facets .facet__n', (n) => n.map((x) => x.textContent));
check('a transaction across two tables commits and the view updates',
  afterCounts.length === 4 && problems.length === 0, problems[0] ?? afterCounts.join('/'));

// The thing only a browser can show: it is still there after a full reload.
const page2 = await open();
const env2 = await page2.textContent('#env');
const status2 = await page2.textContent('#status');
check('data survives a full page reload (real OPFS durability)',
  /5,000 issues/.test(env2) && /survived the reload/.test(status2), `${env2.trim()} · ${status2.trim()}`);

check('no page errors or failed requests anywhere', problems.length === 0, problems[0] ?? '');

await browser.close();
server.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nshowcase: a real app over 5,000 rows behaves');
process.exit(failures ? 1 : 0);
