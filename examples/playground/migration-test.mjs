/**
 * Drives the end-to-end Dexie -> granth migration in a real browser.
 *
 * Real IndexedDB, real OPFS, ~2,700 rows across two tables — including an
 * explicit string primary key, a unique index, a compound index and a multiEntry
 * array. Every query is asked of BOTH databases and the answers diffed, so this
 * cannot pass by agreeing with an expectation I wrote myself.
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
console.log(`— ${name}: Dexie → granth migration —`);
await page.goto(`${base}/migrate.html`);

let res;
try {
  await page.waitForFunction(() => window.__RESULTS__ !== undefined, null, { timeout: 240_000 });
  res = await page.evaluate(() => window.__RESULTS__);
} catch {
  res = { fatal: 'timed out waiting for __RESULTS__', failed: 1 };
}

if (res.fatal) console.error(`FATAL — ${res.fatal}`);
else for (const r of res.results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ' — ' + r.detail : ''}`);

await browser.close();
await server.close();
console.log(res.failed ? `\n${res.failed} FAILURE(S)` : `\nmigration: ${res.total} checks, Dexie and granth agree on every one`);
process.exit(res.failed ? 1 : 0);
