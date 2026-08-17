/**
 * Every framework demo must actually mount and write to the database.
 *
 * A demo that renders an empty shell looks fine in a screenshot and is useless.
 * This adds a todo through the real UI and asserts it appears — the same check
 * for every framework, so none of them can quietly rot.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const server = await createServer({ root, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const origin = `http://localhost:${server.httpServer.address().port}`;

const browser = await chromium.launch();
let failures = 0;

for (const name of ['vanilla', 'react', 'vue', 'svelte', 'solid', 'no-worker']) {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  try {
    await page.goto(`${origin}/demos/${name}.html`, { waitUntil: 'networkidle' });
    await page.waitForSelector('form input', { timeout: 30_000 });

    const text = `from ${name} ${Date.now()}`;
    await page.fill('form input', text);
    await page.click('form button[type=submit], form button');
    await page.waitForFunction(
      (t) => document.querySelector('main')?.innerText.includes(t),
      text,
      { timeout: 20_000 }
    );
    if (errs.length) throw new Error(errs[0]);
    console.log(`PASS  ${name} — mounted and wrote a row`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name} — ${String(err.message).slice(0, 110)}`);
    if (errs.length) console.log(`        page error: ${errs[0].slice(0, 110)}`);
  }
  await page.close();
}

await browser.close();
await server.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall framework demos mount and write');
process.exit(failures ? 1 : 0);
