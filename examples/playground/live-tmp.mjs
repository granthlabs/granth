import { chromium } from 'playwright';
const ORIGIN = 'https://granthlabs.github.io';
const b = await chromium.launch();

/** Click a link the way a person does, and report what the page becomes. */
async function clickThrough(from, selector, label) {
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  await p.goto(ORIGIN + from, { waitUntil: 'networkidle', timeout: 60000 });
  const el = await p.$(selector);
  if (!el) { console.log(`SKIP  ${label} — no such link`); await p.close(); return; }
  await el.click();
  await p.waitForTimeout(2500);
  const url = new URL(p.url()).pathname;
  const title = (await p.title()).slice(0, 40);
  const body = (await p.evaluate(() => document.body.innerText.slice(0, 120))).replace(/\s+/g, ' ');
  const is404 = /404|PAGE NOT FOUND|not found/i.test(title + ' ' + body);
  console.log(`${is404 ? 'FAIL ' : 'PASS '} ${label}\n        → ${url}  title="${title}"\n        ${body.slice(0, 90)}`);
  await p.close();
}

console.log('— clicking links as a person would —');
await clickThrough('/', 'a.ghero__secondary', 'hero: Try it in your browser');
await clickThrough('/', 'a.ghero__cta', 'hero: Get started');
await clickThrough('/', '.built__actions a.ghero__cta', 'showcase: Open the app');
await clickThrough('/getting-started', 'a[href$="/play/sandbox"]', 'getting-started: Sandbox link');
await clickThrough('/docs', 'a[href$="/play/showcase/"]', 'docs: Showcase link');
await clickThrough('/', '.VPNavBar a[href$="/play/sandbox"]', 'nav: Sandbox');

await b.close();
