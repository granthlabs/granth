/**
 * Crawls the built docs site and fails on any broken internal link.
 *
 * This exists because of a specific class of bug: the site is served under
 * /granth/, so a bare `/Tutorial` href works on a root-served dev server and
 * 404s in production. That asymmetry means broken links reach a deploy looking
 * fine locally — every internal link now goes through withBase(), and this
 * proves it stayed that way.
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '../../docs/.vitepress/dist');
const BASE = '/granth/';

if (!existsSync(DIST)) {
  console.error('link-check: no build found. Run `npm run docs:build` first.');
  process.exit(1);
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2' };

/** Resolve a URL path to a file the way a static host would. */
function resolveFile(urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  if (rel.startsWith(BASE)) rel = rel.slice(BASE.length);
  rel = rel.replace(/^\/+/, '');
  const candidates = [rel, `${rel}.html`, join(rel, 'index.html')];
  for (const c of candidates) {
    const full = join(DIST, c);
    if (full.startsWith(DIST) && existsSync(full) && statSync(full).isFile()) return full;
  }
  return null;
}

const server = createServer((req, res) => {
  const file = resolveFile(req.url);
  if (!file) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});

await new Promise((r) => server.listen(0, r));
const origin = `http://localhost:${server.address().port}`;

/** Every page the site actually builds, plus whatever they link to. */
const queue = [`${BASE}`];
const seen = new Set();
const broken = [];
let checked = 0;

while (queue.length) {
  const path = queue.shift();
  if (seen.has(path)) continue;
  seen.add(path);

  const file = resolveFile(path);
  if (!file) { broken.push({ path, why: '404' }); continue; }
  checked++;
  if (extname(file) !== '.html') continue;

  const html = readFileSync(file, 'utf8');
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    const href = m[1];
    if (/^(https?:|mailto:|#|data:)/.test(href)) continue;
    const target = href.startsWith('/') ? href : new URL(href, origin + path).pathname;
    if (!seen.has(target)) queue.push(target);
  }
}

server.close();

if (broken.length) {
  console.error(`link-check: ${broken.length} broken link(s):`);
  for (const b of broken) console.error(`  ${b.why}  ${b.path}`);
  process.exit(1);
}
console.log(`link-check: ${checked} pages, no broken internal links`);
process.exit(0);
