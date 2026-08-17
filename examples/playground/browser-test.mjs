/**
 * Headless run of the browser suites.
 *
 * This exists because the Node suites cannot see the platform: OPFS, the
 * opfs-sahpool VFS, dedicated Workers and Web Locks. A change can be green in
 * Node and broken in every browser, so "npm test passed" is not evidence that
 * the library works. CI runs this too.
 *
 * The pages publish `window.__RESULTS__`; we exit non-zero on any failure.
 */

import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

// fresh and reload MUST run in the same browser context, in this order: the
// reload phase asserts that the fresh phase's data survived in real OPFS.
const PAGES = [
  { path: '/?phase=fresh', name: 'main (fresh)' },
  { path: '/?phase=reload', name: 'main (reload)' },
  { path: '/compat.html', name: 'compat + Dexie migration' },
];

const server = await createServer({ root, server: { port: 0 }, logLevel: 'warn' });
await server.listen();
const { port } = server.httpServer.address();
const base = `http://localhost:${port}`;

const browser = await chromium.launch();
const context = await browser.newContext();
let failed = 0;

for (const { path, name } of PAGES) {
  const page = await context.newPage();
  page.on('pageerror', (err) => console.error(`  page error: ${err.message}`));
  await page.goto(base + path);

  let res;
  try {
    // Generous: a cold sqlite-wasm compile on a CI runner is slow.
    await page.waitForFunction(() => window.__RESULTS__ !== undefined, null, { timeout: 120_000 });
    res = await page.evaluate(() => window.__RESULTS__);
  } catch {
    res = { fatal: 'timed out waiting for __RESULTS__', failed: 1 };
  }

  if (res.fatal) {
    failed++;
    console.error(`FAIL  ${name} — ${res.fatal}`);
  } else if (res.failed) {
    failed += res.failed;
    console.error(`FAIL  ${name} — ${res.failed} of ${res.total}`);
    for (const r of res.results.filter((r) => !r.ok)) console.error(`        ${r.name} — ${r.detail}`);
  } else {
    console.log(`PASS  ${name} — ${res.total}/${res.total}`);
  }
  await page.close();
}

await browser.close();
await server.close();
process.exit(failed ? 1 : 0);
