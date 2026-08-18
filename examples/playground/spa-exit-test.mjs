/**
 * Every link that LEAVES the VitePress SPA must actually leave it.
 *
 * link-check.mjs fetches URLs and they all return 200 — and the pages were still
 * broken, because the failure only happens on a CLICK. VitePress routes
 * same-origin links client-side, and `/play/…` is not one of its routes, so it
 * swapped in its own 404 page without ever requesting the file. "Try it in your
 * browser" looked fine to every automated check and 404'd for every human.
 *
 * The fix is `target="_self"`; this is the check that proves it, by clicking.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '../../docs/.vitepress/dist');
const BASE = process.env.DOCS_BASE ?? '/';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png' };

if (!existsSync(join(DIST, 'play'))) {
  console.error('spa-exit: no build found. Run `npm run docs:build` first.');
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

const browser = await chromium.launch();
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

/**
 * Find every link into /play/ on a page and click each one, asserting we land on
 * the real document rather than the SPA's 404.
 */
async function clickAllExits(path) {
  const page = await browser.newPage();
  await page.goto(origin + BASE + path, { waitUntil: 'networkidle', timeout: 60_000 });
  const hrefs = await page.$$eval('a[href]', (as) =>
    as.map((a) => a.getAttribute('href')).filter((h) => h && /\/play\//.test(h)));
  const unique = [...new Set(hrefs)];
  if (!unique.length) { await page.close(); return { checked: 0, bad: [] }; }

  const bad = [];
  for (const href of unique) {
    const p = await browser.newPage();
    await p.goto(origin + BASE + path, { waitUntil: 'networkidle', timeout: 60_000 });
    const el = await p.$(`a[href="${href}"]`);
    if (el) {
      await el.click().catch(() => {});
      await p.waitForTimeout(1200);
      const title = await p.title();
      // The SPA 404 keeps the VitePress shell, so its title is the tell.
      if (/404/.test(title)) bad.push(`${href} → "${title}"`);
    }
    await p.close();
  }
  await page.close();
  return { checked: unique.length, bad };
}

for (const path of ['', 'getting-started', 'docs']) {
  const { checked, bad } = await clickAllExits(path);
  check(`clicking every /play/ link on /${path}`, bad.length === 0,
    bad.length ? bad.join('; ') : `${checked} link(s) reach the real page`);
}

await browser.close();
server.close();
console.log(failures ? `\n${failures} link(s) are swallowed by the SPA router` : '\nevery link out of the SPA actually leaves it');
process.exit(failures ? 1 : 0);
