/**
 * Drives the scale harness in a real browser against real OPFS.
 *
 * Kept out of the default CI run: 100,000 rows takes long enough that it would
 * slow every commit for a property that changes rarely. Run it before a release,
 * or when anything touches the query compiler or the bulk paths.
 */
import { createServer } from 'vite';
import { chromium, firefox, webkit } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const engines = { chromium, firefox, webkit };
const name = process.env.BROWSER ?? 'chromium';
const server = await createServer({ root, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}`;

const browser = await engines[name].launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.error(`  page error: ${e.message}`));
console.log(`— ${name}: 100,000 rows —`);
await page.goto(`${base}/scale.html`);

let res;
try {
  await page.waitForFunction(() => window.__RESULTS__ !== undefined, null, { timeout: 600_000 });
  res = await page.evaluate(() => window.__RESULTS__);
} catch { res = { fatal: 'timed out', failed: 1 }; }

if (res.fatal) console.error(`FATAL — ${res.fatal}`);
else for (const r of res.results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ' — ' + r.detail : ''}`);

await browser.close();
await server.close();
console.log(res.failed ? `\n${res.failed} FAILURE(S)` : `\nscale: ${res.total} checks at 100,000 rows`);
process.exit(res.failed ? 1 : 0);
