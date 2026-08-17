/**
 * Smoke test for the sandbox: it must actually open a database and every
 * bundled example must RUN. A sandbox whose examples throw is worse than none,
 * because it is the first thing a visitor tries.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const server = await createServer({ root, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}/sandbox.html`;

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.error(`  page error: ${e.message}`));
await page.goto(base);
await page.waitForFunction(() => window.__SANDBOX_READY__ || window.__SANDBOX_ERROR__, null, { timeout: 90_000 });

let failures = 0;
const err = await page.evaluate(() => window.__SANDBOX_ERROR__);
if (err) { console.log(`FAIL  sandbox failed to open — ${err}`); failures++; }

const env = await page.textContent('#env');
console.log(`PASS  opened — ${env}`);

const count = await page.$$eval('#examples option', (o) => o.length);
for (let i = 0; i < count; i++) {
  await page.selectOption('#examples', String(i));
  const label = await page.$eval('#examples', (s) => s.selectedOptions[0].textContent);
  await page.click('#run');
  await page.waitForFunction(() => !document.getElementById('run').disabled, null, { timeout: 30_000 });
  const isError = await page.$eval('#out', (el) => el.classList.contains('err'));
  const text = (await page.textContent('#out')).slice(0, 90).replace(/\s+/g, ' ');
  if (isError) { failures++; console.log(`FAIL  ${label} — ${text}`); }
  else console.log(`PASS  ${label} — ${text}`);
}

await browser.close();
await server.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nsandbox: every example runs');
process.exit(failures ? 1 : 0);
