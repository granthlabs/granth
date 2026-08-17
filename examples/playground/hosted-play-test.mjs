/**
 * Drives the BUILT sandbox and demos exactly as GitHub Pages will serve them.
 *
 * demos-test.mjs and sandbox-test.mjs run against the Vite DEV server, which
 * resolves modules on the fly at base `/`. The deployed copy is a rollup bundle
 * under `/granth/play/`, where three things can break invisibly:
 *
 *   - base-relative asset URLs (the exact 404-in-production trap link-check
 *     exists for on the docs side),
 *   - the `new Worker(new URL(...))` pattern, which rollup rewrites,
 *   - sqlite-wasm's .wasm fetch, which resolves relative to the emitted chunk.
 *
 * None of those show up in a dev-server run, so a green demos-test says nothing
 * about the artifact users actually load.
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { chromium } from 'playwright';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '../../docs/.vitepress/dist');
const BASE = '/granth/';

if (!existsSync(join(DIST, 'play'))) {
  console.error('hosted-play: no build found. Run `npm run docs:build` first.');
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png',
};

const server = createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  if (rel.startsWith(BASE)) rel = rel.slice(BASE.length);
  rel = rel.replace(/^\/+/, '');
  for (const c of [rel, `${rel}.html`, join(rel, 'index.html')]) {
    const full = join(DIST, c);
    if (full.startsWith(DIST) && existsSync(full) && statSync(full).isFile()) {
      // NO COOP/COEP, matching GitHub Pages: opfs-sahpool must work without
      // cross-origin isolation, which is the whole reason that VFS was chosen.
      res.writeHead(200, { 'content-type': TYPES[extname(full)] ?? 'application/octet-stream' });
      return res.end(readFileSync(full));
    }
  }
  res.writeHead(404).end('not found');
});
await new Promise((r) => server.listen(0, r));
const origin = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

/** A page that logs a 404 or a page error has broken assets even if it renders. */
const open = async (path) => {
  const page = await browser.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`${r.status()} ${r.url().replace(origin, '')}`);
  });
  await page.goto(`${origin}${BASE}play/${path}`, { waitUntil: 'networkidle' });
  return { page, problems };
};

// The sandbox, running EVERY bundled example — the same assertions
// sandbox-test.mjs makes against the dev server, now against the artifact.
{
  const { page, problems } = await open('sandbox.html');
  try {
    await page.waitForFunction(() => window.__SANDBOX_READY__ || window.__SANDBOX_ERROR__, null, { timeout: 90_000 });
    const err = await page.evaluate(() => window.__SANDBOX_ERROR__);
    const env = (await page.textContent('#env')).trim();
    check('built sandbox opens a database', !err && problems.length === 0, err || problems[0] || env);

    const count = await page.$$eval('#examples option', (o) => o.length);
    let bad = 0;
    for (let i = 0; i < count; i++) {
      await page.selectOption('#examples', String(i));
      await page.click('#run');
      await page.waitForFunction(() => !document.getElementById('run').disabled, null, { timeout: 30_000 });
      if (await page.$eval('#out', (el) => el.classList.contains('err'))) {
        bad++;
        const label = await page.$eval('#examples', (s) => s.selectedOptions[0].textContent);
        console.log(`        example failed: ${label} — ${(await page.textContent('#out')).slice(0, 80)}`);
      }
    }
    check(`built sandbox runs all ${count} examples`, bad === 0 && problems.length === 0,
      bad ? `${bad} failed` : problems[0] ?? '');
  } catch (e) {
    check('built sandbox opens a database', false, problems[0] ?? String(e.message).slice(0, 110));
  }
  await page.close();
}

// Every framework demo, through the built bundle rather than the dev server.
for (const name of ['vanilla', 'react', 'vue', 'svelte', 'solid', 'no-worker']) {
  const { page, problems } = await open(`demos/${name}.html`);
  let ok = false;
  let detail = problems[0] ?? '';
  try {
    await page.waitForSelector('form input', { timeout: 45_000 });
    const text = `hosted ${name}`;
    await page.fill('form input', text);
    await page.click('form button[type=submit], form button');
    await page.waitForFunction(
      (t) => document.querySelector('main')?.innerText.includes(t),
      text,
      { timeout: 30_000 }
    );
    ok = problems.length === 0;
    detail = problems[0] ?? '';
  } catch (err) {
    detail = problems[0] ?? String(err.message).slice(0, 110);
  }
  check(`built demo: ${name}`, ok, detail);
  await page.close();
}

// The hub is what the site links to, so its links must resolve on the host.
{
  const { page, problems } = await open('demos/');
  const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')));
  const broken = [];
  for (const h of hrefs) {
    if (/^(https?:|mailto:|#)/.test(h)) continue;
    const r = await page.request.get(new URL(h, `${origin}${BASE}play/demos/`).toString());
    if (!r.ok()) broken.push(`${h} -> ${r.status()}`);
  }
  check('demo hub links all resolve', broken.length === 0 && problems.length === 0,
    broken.join(', ') || problems[0] || `${hrefs.length} links`);
  await page.close();
}

await browser.close();
server.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nhosted sandbox + demos all work as built');
process.exit(failures ? 1 : 0);
